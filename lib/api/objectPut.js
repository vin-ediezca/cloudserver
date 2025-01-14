const async = require('async');
const { errors, versioning } = require('arsenal');

const constants = require('../../constants');
const aclUtils = require('../utilities/aclUtils');
const { cleanUpBucket } = require('./apiUtils/bucket/bucketCreation');
const collectCorsHeaders = require('../utilities/collectCorsHeaders');
const createAndStoreObject = require('./apiUtils/object/createAndStoreObject');
const { checkQueryVersionId } = require('./apiUtils/object/versioning');
const { metadataValidateBucketAndObj } = require('../metadata/metadataUtils');
const { pushMetric } = require('../utapi/utilities');
const kms = require('../kms/wrapper');
const monitoring = require('../utilities/monitoringHandler');

const versionIdUtils = versioning.VersionID;

/**
 * PUT Object in the requested bucket. Steps include:
 * validating metadata for authorization, bucket and object existence etc.
 * store object data in datastore upon successful authorization
 * store object location returned by datastore and
 * object's (custom) headers in metadata
 * return the result in final callback
 *
 * @param {AuthInfo} authInfo - Instance of AuthInfo class with requester's info
 * @param {request} request - request object given by router,
 *                            includes normalized headers
 * @param {object | undefined } streamingV4Params - if v4 auth,
 * object containing accessKey, signatureFromRequest, region, scopeDate,
 * timestamp, and credentialScope
 * (to be used for streaming v4 auth if applicable)
 * @param {object} log - the log request
 * @param {Function} callback - final callback to call with the result
 * @return {undefined}
 */
function objectPut(authInfo, request, streamingV4Params, log, callback) {
    log.debug('processing request', { method: 'objectPut' });
    if (!aclUtils.checkGrantHeaderValidity(request.headers)) {
        log.trace('invalid acl header');
        monitoring.promMetrics('PUT', request.bucketName, 400,
            'putObject');
        return callback(errors.InvalidArgument);
    }
    const queryContainsVersionId = checkQueryVersionId(request.query);
    if (queryContainsVersionId instanceof Error) {
        return callback(queryContainsVersionId);
    }
    const size = request.parsedContentLength;
    if (Number.parseInt(size, 10) > constants.maximumAllowedUploadSize) {
        log.debug('Upload size exceeds maximum allowed for a single PUT',
            { size });
        return callback(errors.EntityTooLarge);
    }

    const bucketName = request.bucketName;
    const objectKey = request.objectKey;
    const requestType = 'objectPut';
    const valParams = { authInfo, bucketName, objectKey, requestType };
    const canonicalID = authInfo.getCanonicalID();
    log.trace('owner canonicalID to send to data', { canonicalID });

    return metadataValidateBucketAndObj(valParams, log,
    (err, bucket, objMD) => {
        const responseHeaders = collectCorsHeaders(request.headers.origin,
            request.method, bucket);
        if (err) {
            log.trace('error processing request', {
                error: err,
                method: 'metadataValidateBucketAndObj',
            });
            monitoring.promMetrics('PUT', bucketName, err.code, 'putObject');
            return callback(err, responseHeaders);
        }
        if (bucket.hasDeletedFlag() && canonicalID !== bucket.getOwner()) {
            log.trace('deleted flag on bucket and request ' +
                'from non-owner account');
            monitoring.promMetrics('PUT', bucketName, 404, 'putObject');
            return callback(errors.NoSuchBucket);
        }
        return async.waterfall([
            function handleTransientOrDeleteBuckets(next) {
                if (bucket.hasTransientFlag() || bucket.hasDeletedFlag()) {
                    return cleanUpBucket(bucket, canonicalID, log, next);
                }
                return next();
            },
            function createCipherBundle(next) {
                const serverSideEncryption = bucket.getServerSideEncryption();
                if (serverSideEncryption) {
                    return kms.createCipherBundle(
                            serverSideEncryption, log, next);
                }
                return next(null, null);
            },
            function objectCreateAndStore(cipherBundle, next) {
                return createAndStoreObject(bucketName,
                bucket, objectKey, objMD, authInfo, canonicalID, cipherBundle,
                request, false, streamingV4Params, log, next);
            },
        ], (err, storingResult) => {
            if (err) {
                monitoring.promMetrics('PUT', bucketName, err.code,
                    'putObject');
                return callback(err, responseHeaders);
            }
            // ingestSize assumes that these custom headers indicate
            // an ingestion PUT which is a metadata only operation.
            // Since these headers can be modified client side, they
            // should be used with caution if needed for precise
            // metrics.
            const ingestSize = (request.headers['x-amz-meta-mdonly']
                && !Number.isNaN(request.headers['x-amz-meta-size']))
                ? Number.parseInt(request.headers['x-amz-meta-size'], 10) : null;
            const newByteLength = request.parsedContentLength;

            // Utapi expects null or a number for oldByteLength:
            // * null - new object
            // * 0 or > 0 - existing object with content-length 0 or > 0
            // objMD here is the master version that we would
            // have overwritten if there was an existing version or object
            //
            // TODO: Handle utapi metrics for null version overwrites.
            const oldByteLength = objMD && objMD['content-length']
                !== undefined ? objMD['content-length'] : null;
            if (storingResult) {
                // ETag's hex should always be enclosed in quotes
                responseHeaders.ETag = `"${storingResult.contentMD5}"`;
            }
            const vcfg = bucket.getVersioningConfiguration();
            const isVersionedObj = vcfg && vcfg.Status === 'Enabled';
            if (isVersionedObj) {
                if (storingResult && storingResult.versionId) {
                    responseHeaders['x-amz-version-id'] =
                        versionIdUtils.encode(storingResult.versionId);
                }
            }
            pushMetric('putObject', log, {
                authInfo,
                bucket: bucketName,
                keys: [objectKey],
                newByteLength,
                oldByteLength: isVersionedObj ? null : oldByteLength,
            });
            monitoring.promMetrics('PUT', bucketName, '200',
                'putObject', newByteLength, oldByteLength, isVersionedObj,
                null, ingestSize);
            return callback(null, responseHeaders);
        });
    });
}

module.exports = objectPut;
