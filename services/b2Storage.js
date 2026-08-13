import "dotenv/config";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import fs from "fs";

const endpoint = process.env.B2_ENDPOINT?.trim();
const bucketName = process.env.B2_BUCKET_NAME?.trim();
const keyId = process.env.B2_KEY_ID?.trim();
const applicationKey = process.env.B2_APPLICATION_KEY?.trim();

if (!endpoint) {
  throw new Error("B2_ENDPOINT is not configured.");
}

if (!bucketName) {
  throw new Error("B2_BUCKET_NAME is not configured.");
}

if (!keyId || !applicationKey) {
  throw new Error("B2_KEY_ID and B2_APPLICATION_KEY must be configured.");
}

let endpointUrl;
try {
  endpointUrl = new URL(endpoint);
} catch {
  throw new Error("B2_ENDPOINT is not a valid URL.");
}

if (endpointUrl.protocol !== "https:") {
  throw new Error("B2_ENDPOINT must use https://");
}

// Backblaze S3 endpoints have the form:
// https://s3.<region>.backblazeb2.com
const endpointMatch = endpointUrl.hostname.match(
  /^s3\.([^.]+)\.backblazeb2\.com$/i
);

if (!endpointMatch) {
  throw new Error(
    `Invalid B2_ENDPOINT: ${endpointUrl.hostname}. Expected https://s3.<region>.backblazeb2.com`
  );
}

const endpointRegion = endpointMatch[1];
const configuredRegion = process.env.B2_REGION?.trim();
const region = configuredRegion || endpointRegion;

if (configuredRegion && configuredRegion !== endpointRegion) {
  throw new Error(
    `B2_REGION (${configuredRegion}) does not match B2_ENDPOINT region (${endpointRegion}).`
  );
}

// Backblaze B2 S3-Compatible API uses AWS Signature V4.
// forcePathStyle keeps the bucket in the request path, which is supported by
// B2 and avoids changing the signing host to <bucket>.<endpoint>.
const b2 = new S3Client({
  endpoint: endpointUrl.origin,
  region,
  forcePathStyle: true,
  credentials: {
    accessKeyId: keyId,
    secretAccessKey: applicationKey,
  },
});

const getB2ErrorMessage = (error, operation) => {
  const code = error?.Code || error?.code;
  const status = error?.$metadata?.httpStatusCode;

  if (status === 401 || code === "UnauthorizedAccess") {
    return `Backblaze rejected the ${operation} request (401 UnauthorizedAccess). ` +
      `"Seed signature is invalid" normally means the B2_KEY_ID and B2_APPLICATION_KEY do not belong together, ` +
      `the application key is not an S3-compatible key, or the key/secret was copied incorrectly. ` +
      `Also verify that B2_ENDPOINT and B2_REGION both use ${endpointRegion}.`;
  }

  return error?.message || `Backblaze ${operation} failed.`;
};

export const uploadToB2 = async ({ filePath, objectKey, contentType }) => {
  if (!filePath || typeof filePath !== "string") {
    throw new TypeError("B2 upload requires filePath to be a string.");
  }

  if (!objectKey || typeof objectKey !== "string") {
    throw new TypeError("B2 upload requires objectKey to be a string.");
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`Temporary upload file not found: ${filePath}`);
  }

  const fileStream = fs.createReadStream(filePath);

  try {
    await b2.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: fileStream,
        ContentType: contentType || "application/octet-stream",
      })
    );

    return objectKey;
  } catch (error) {
    fileStream.destroy();
    console.error(`B2 upload failed: ${getB2ErrorMessage(error, "upload")}`);
    throw error;
  }
};

export const getFromB2 = async (objectKey) => {
  if (!objectKey || typeof objectKey !== "string") {
    throw new TypeError("B2 download requires objectKey to be a string.");
  }

  try {
    return await b2.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
      })
    );
  } catch (error) {
    console.error(`B2 download failed: ${getB2ErrorMessage(error, "download")}`);
    throw error;
  }
};

export const deleteFromB2 = async (objectKey) => {
  if (!objectKey || typeof objectKey !== "string") {
    throw new TypeError("B2 deletion requires objectKey to be a string.");
  }

  try {
    await b2.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
      })
    );
  } catch (error) {
    console.error(`B2 deletion failed: ${getB2ErrorMessage(error, "deletion")}`);
    throw error;
  }
};
