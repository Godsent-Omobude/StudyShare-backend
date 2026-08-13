import "dotenv/config";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import fs from "fs";

const b2 = new S3Client({
  region: process.env.B2_REGION,
  endpoint: process.env.B2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});

/**
 * Upload a temporary file from the Render/local filesystem to Backblaze B2.
 *
 * The object form is intentional: it prevents accidentally passing the
 * entire options object to fs.createReadStream(), which causes:
 * "The path argument must be of type string... Received an instance of Object".
 */
export const uploadToB2 = async ({
  filePath,
  objectKey,
  contentType,
}) => {
  if (!filePath || typeof filePath !== "string") {
    throw new TypeError("B2 upload requires filePath to be a string.");
  }

  if (!objectKey || typeof objectKey !== "string") {
    throw new TypeError("B2 upload requires objectKey to be a string.");
  }

  if (!process.env.B2_BUCKET_NAME) {
    throw new Error("B2_BUCKET_NAME is not configured.");
  }

  if (!process.env.B2_ENDPOINT) {
    throw new Error("B2_ENDPOINT is not configured.");
  }

  if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY) {
    throw new Error("Backblaze B2 credentials are not configured.");
  }

  const fileStream = fs.createReadStream(filePath);

  const command = new PutObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: objectKey,
    Body: fileStream,
    ContentType: contentType || "application/octet-stream",
  });

  try {
    await b2.send(command);
    return objectKey;
  } catch (error) {
    fileStream.destroy();
    throw error;
  }
};

/**
 * Get a file from Backblaze B2.
 */
export const getFromB2 = async (objectKey) => {
  if (!objectKey || typeof objectKey !== "string") {
    throw new TypeError("B2 download requires objectKey to be a string.");
  }

  const command = new GetObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: objectKey,
  });

  return await b2.send(command);
};

/**
 * Delete a file from Backblaze B2.
 */
export const deleteFromB2 = async (objectKey) => {
  if (!objectKey || typeof objectKey !== "string") {
    throw new TypeError("B2 deletion requires objectKey to be a string.");
  }

  const command = new DeleteObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: objectKey,
  });

  await b2.send(command);
};
