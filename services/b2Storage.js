import "dotenv/config";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import fs from "fs";
import path from "path";

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

if (!endpoint.startsWith("https://")) {
  throw new Error("B2_ENDPOINT must start with https://");
}

// Backblaze requires the SigV4 signing region to match the region in the
// bucket's S3 endpoint. Example:
// https://s3.us-west-004.backblazeb2.com -> us-west-004
const endpointUrl = new URL(endpoint);
const regionFromEndpoint = endpointUrl.hostname.match(
  /^s3\.([^.]+)\.backblazeb2\.com$/i
)?.[1];

const region = process.env.B2_REGION?.trim() || regionFromEndpoint;

if (!region) {
  throw new Error(
    "Unable to determine B2 region. Set B2_REGION to the region shown in your B2 S3 endpoint."
  );
}

const b2 = new S3Client({
  endpoint: endpointUrl.toString().replace(/\/$/, ""),
  region,
  credentials: {
    accessKeyId: keyId,
    secretAccessKey: applicationKey,
  },
});

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
    throw error;
  }
};

export const getFromB2 = async (objectKey) => {
  if (!objectKey || typeof objectKey !== "string") {
    throw new TypeError("B2 download requires objectKey to be a string.");
  }

  return b2.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
    })
  );
};

export const deleteFromB2 = async (objectKey) => {
  if (!objectKey || typeof objectKey !== "string") {
    throw new TypeError("B2 deletion requires objectKey to be a string.");
  }

  await b2.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
    })
  );
};
