import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import prisma from "../config/prisma.js";
import { protect } from "../middleware/auth.js";
import {
  uploadToB2,
  getFromB2,
  deleteFromB2,
} from "../services/b2Storage.js";

const router = express.Router();

// Multer stores the upload temporarily on Render. The temporary file is
// copied to B2 and removed after the B2 + database operations succeed.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`),
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    ".pdf",
    ".docx",
    ".pptx",
    ".ppt",
    ".png",
    ".jpg",
    ".jpeg",
  ];

  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid file type. Only PDFs, Documents, Presentations, and Images are allowed."
      )
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 },
});

const createObjectKey = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  const safeBase = path
    .basename(filename, ext)
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100);

  return `documents/${randomUUID()}-${safeBase}${ext}`;
};

router.post(
  "/upload",
  protect,
  upload.single("file"),
  async (req, res) => {
    const { title, description, courseCode, type } = req.body;

    if (!req.file) {
      return res
        .status(400)
        .json({ message: "Please upload a physical file." });
    }

    let objectKey = null;

    try {
      objectKey = createObjectKey(req.file.originalname);

      await uploadToB2({
        filePath: req.file.path,
        objectKey,
        contentType: req.file.mimetype,
      });

      const newFile = await prisma.file.create({
        data: {
          title,
          description,
          courseCode: courseCode ? courseCode.toUpperCase() : null,
          type,
          filename: req.file.originalname,
          filepath: objectKey,
          mimetype: req.file.mimetype,
          uploadedBy: req.user.id,
          uploaderName: req.user.showUsernameOnMaterials === false
            ? "Anonymous"
            : req.user.username,
        },
      });

      await fs.promises.unlink(req.file.path).catch(() => {});

      return res.status(201).json({
        ...newFile,
        uploaderName: req.user.showUsernameOnMaterials ? req.user.username : null,
      });
    } catch (error) {
      await fs.promises.unlink(req.file.path).catch(() => {});

      // If B2 succeeded but the database write failed, remove the orphaned
      // B2 object. Do not let cleanup hide the original error.
      if (objectKey) {
        await deleteFromB2(objectKey).catch((cleanupError) => {
          console.error("B2 orphan cleanup error:", cleanupError);
        });
      }

      console.error("File upload error:", error);

      const status =
        error?.$metadata?.httpStatusCode === 401 ||
        error?.Code === "UnauthorizedAccess" ||
        error?.code === "UnauthorizedAccess"
          ? 502
          : 500;

      const isB2AuthError = status === 502;

      return res.status(status).json({
        message: isB2AuthError
          ? "Backblaze rejected the upload. 'Seed signature is invalid' usually means B2_KEY_ID and B2_APPLICATION_KEY do not belong together, the application key is not S3-compatible, or B2_ENDPOINT/B2_REGION does not match the bucket."
          : error.message,
      });
    }
  }
);

router.get("/", protect, async (req, res) => {
  try {
    const files = await prisma.file.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: {
            username: true,
            showUsernameOnMaterials: true,
          },
        },
      },
    });

    const visibleFiles = files.map(({ user, ...file }) => ({
      ...file,
      uploaderName: user?.showUsernameOnMaterials ? user.username : null,
    }));

    res.json(visibleFiles);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/download/:id", protect, async (req, res) => {
  try {
    const fileId = Number.parseInt(req.params.id, 10);

    if (Number.isNaN(fileId)) {
      return res.status(400).json({ message: "Invalid file ID." });
    }

    const file = await prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      return res.status(404).json({ message: "File not found" });
    }

    // Backward compatibility for files that were stored on Render before B2.
    if (file.filepath.startsWith("uploads/") && fs.existsSync(file.filepath)) {
      await prisma.file.update({
        where: { id: fileId },
        data: { downloads: { increment: 1 } },
      });

      return res.download(
        file.filepath,
        file.title + path.extname(file.filename)
      );
    }

    const b2File = await getFromB2(file.filepath);

    await prisma.file.update({
      where: { id: fileId },
      data: { downloads: { increment: 1 } },
    });

    res.setHeader(
      "Content-Type",
      file.mimetype || "application/octet-stream"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(
        file.title + path.extname(file.filename)
      )}`
    );

    if (b2File.ContentLength !== undefined) {
      res.setHeader("Content-Length", b2File.ContentLength);
    }

    b2File.Body.pipe(res);
  } catch (error) {
    console.error("B2 download error:", error);
    res.status(500).json({ message: "Unable to download this file." });
  }
});

export default router;
