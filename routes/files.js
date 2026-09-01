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
import {
  scanCopyright,
  COPYRIGHT_CONFIRMATION_VERSION,
} from "../services/copyrightScanner.js";
import { notifyUploaderOfCopyrightEvent } from "../services/copyrightNotify.js";

const router = express.Router();

// Multer stores the upload temporarily on Render. The temporary file is
// copied to B2 and removed after the B2 + database operations succeed.
// The on-disk filename is generated server-side (never derived from the
// user-supplied originalname) to rule out path traversal or collisions.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${randomUUID()}${ext}`);
  },
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

// A file is visible/downloadable to the general population only once
// it's CLEARED. The uploader can always see their own file (so they know
// what's happening with it); admins can always see everything. This is
// enforced here — not just hidden in the frontend — per the copyright
// access-control requirement.
const isVisibleToViewer = (file, viewerId, viewerRole) => {
  if (viewerRole === "admin") return true;
  if (file.uploadedBy === viewerId) return true;
  return file.copyrightStatus === "CLEARED";
};

router.post(
  "/upload",
  protect,
  upload.single("file"),
  async (req, res) => {
    const { title, description, courseCode, type, copyrightConfirmation } = req.body;

    if (copyrightConfirmation !== "true") {
      return res.status(400).json({
        message:
          "You must confirm that you have the right or permission to upload this material.",
      });
    }

    if (!req.file) {
      return res
        .status(400)
        .json({ message: "Please upload a physical file." });
    }

    let objectKey = null;
    const normalizedCourseCode = courseCode ? courseCode.toUpperCase() : null;

    try {
      // Screen locally (+ optional web check) before permanent B2 storage.
      // Per Study2Gate's copyright policy, a risk signal alone never bans
      // the uploader or silently deletes their work — it only determines
      // whether the material publishes immediately or goes to the
      // Copyright Review Queue for an administrator to look at. See
      // COPYRIGHT_SCREENING.md and services/copyrightScanner.js.
      let copyrightScan;
      try {
        copyrightScan = await scanCopyright({
          filePath: req.file.path,
          originalName: req.file.originalname,
          courseCode: normalizedCourseCode,
        });
      } catch (scanError) {
        // A failed screen (extraction crash, DB hiccup) must not silently
        // delete the file or ban the user — hold it for manual review
        // instead of guessing.
        console.error("Copyright scan failed, holding for manual review:", scanError);
        copyrightScan = {
          contentHash: null,
          fingerprint: [],
          exactDuplicate: null,
          similarityScore: 0,
          duplicateOfId: null,
          risk: "MEDIUM",
          score: 0,
          scanFailed: true,
          reasons: ["Automated copyright screening failed; held for manual review."],
          webMatchFound: false,
          webMatchCount: 0,
          sourceReferences: [],
          textWasExtracted: false,
        };
      }

      // LOW risk -> publish now. MEDIUM/HIGH -> hold (never rejected
      // outright, never deletes the file, never bans the uploader).
      const copyrightStatus = copyrightScan.risk === "LOW" ? "CLEARED" : "REVIEW_REQUIRED";
      const reviewRequired = copyrightStatus !== "CLEARED";

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
          courseCode: normalizedCourseCode,
          type,
          filename: req.file.originalname,
          filepath: objectKey,
          mimetype: req.file.mimetype,
          uploadedBy: req.user.id,
          uploaderName: req.user.showUsernameOnMaterials === false
            ? "Anonymous"
            : req.user.username,
          copyrightConfirmedAt: new Date(),
          copyrightConfirmationVersion: COPYRIGHT_CONFIRMATION_VERSION,
          // Legacy scan-status fields, kept for back-compat with any
          // existing reporting built against them.
          copyrightScanStatus: copyrightScan.risk === "LOW" ? "APPROVED" : copyrightScan.risk === "HIGH" ? "BLOCKED" : "REVIEW",
          copyrightRiskScore: copyrightScan.score,
          copyrightScanCheckedAt: new Date(),
          contentHash: copyrightScan.contentHash,
          // Canonical moderation fields.
          copyrightStatus,
          copyrightRisk: copyrightScan.risk,
          copyrightScore: copyrightScan.score,
          copyrightScanFailed: Boolean(copyrightScan.scanFailed),
          copyrightCheckedAt: new Date(),
          textFingerprint: copyrightScan.fingerprint || [],
          similarityScore: copyrightScan.similarityScore || 0,
          duplicateOfId: copyrightScan.duplicateOfId || null,
          webMatchFound: Boolean(copyrightScan.webMatchFound),
          sourceReferences: copyrightScan.sourceReferences?.length
            ? copyrightScan.sourceReferences
            : undefined,
          reviewRequired,
          reviewReason: reviewRequired ? copyrightScan.reasons.join(" ") : null,
        },
      });

      await fs.promises.unlink(req.file.path).catch(() => {});

      if (reviewRequired) {
        await notifyUploaderOfCopyrightEvent({
          userId: req.user.id,
          templateKey: "REVIEW",
          fileTitle: newFile.title,
          fileId: newFile.id,
        }).catch((error) => console.warn("Copyright notify failed:", error.message));
      }

      return res.status(201).json({
        ...newFile,
        uploaderName: req.user.showUsernameOnMaterials ? req.user.username : null,
        message: reviewRequired
          ? "Your upload was received and is undergoing copyright review before it becomes publicly visible. You can still see it in My Materials."
          : undefined,
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
    // Backend-enforced visibility: a RESTRICTED/REMOVED/REVIEW_REQUIRED
    // file never appears in the general listing for anyone except its
    // uploader and admins — not just hidden by the frontend. See section
    // 18 (File Access Control) of the copyright spec.
    //
    // This used to be `findMany` with no `where` at all — fetching every
    // file row (admin-only rows included) and filtering in JS afterwards.
    // The same isVisibleToViewer rule is applied here as a `where` clause
    // instead, so the database only ever returns rows the requester is
    // actually allowed to see, and the query gets cheaper as the table
    // grows rather than scaling with total files ever uploaded.
    const visibilityWhere =
      req.user.role === "admin"
        ? {}
        : { OR: [{ copyrightStatus: "CLEARED" }, { uploadedBy: req.user.id }] };

    const files = await prisma.file.findMany({
      where: visibilityWhere,
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
    console.error("List files error:", error);
    res.status(500).json({ message: "Unable to load materials right now. Please try again." });
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

    // Enforced server-side regardless of how the request arrives (direct
    // link, cached frontend state, a Study Circle share, etc.) — see
    // section 18 of the copyright spec.
    if (!isVisibleToViewer(file, req.user.id, req.user.role)) {
      return res.status(403).json({
        message:
          file.copyrightStatus === "REMOVED"
            ? "This material has been removed following a copyright review."
            : file.copyrightStatus === "RESTRICTED"
            ? "Access to this material is temporarily restricted while a copyright concern is reviewed."
            : "This material is not yet available.",
        code: "COPYRIGHT_ACCESS_BLOCKED",
      });
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
