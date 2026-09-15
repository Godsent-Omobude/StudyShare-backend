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
import { validateExternalUrl } from "../utils/urlValidation.js";

const SOURCE_TYPES = ["UPLOAD", "EXTERNAL_LINK"];

// --- Download Credit System -------------------------------------------
// Every successfully uploaded document (sourceType UPLOAD — an
// EXTERNAL_LINK isn't a document Study2Gate hosts, so it doesn't earn
// credits) awards this many download credits. Downloading a document
// spends 1. The balance lives on User.downloadCredits and is always
// mutated through an atomic, conditional database update — never trusted
// from the client — so it stays correct across concurrent requests,
// devices, and sessions. See migrations/20260911110000_add_download_credits.
const CREDITS_PER_UPLOAD = 2;
const DOWNLOAD_CREDIT_COST = 1;

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
    const {
      title,
      description,
      courseCode,
      type,
      copyrightConfirmation,
      externalUrl,
    } = req.body;

    // Back-compat: requests from before this feature existed never sent
    // sourceType at all, and must keep behaving exactly as an UPLOAD.
    const sourceType = SOURCE_TYPES.includes(req.body.sourceType)
      ? req.body.sourceType
      : "UPLOAD";

    if (copyrightConfirmation !== "true") {
      return res.status(400).json({
        message:
          "You must confirm that you have the right or permission to share this material.",
      });
    }

    // Reject inconsistent combinations up front rather than silently
    // ignoring one side of the request.
    if (sourceType === "EXTERNAL_LINK" && req.file) {
      return res.status(400).json({
        message: "External resources cannot be uploaded as files.",
      });
    }

    if (sourceType === "UPLOAD" && !req.file) {
      return res
        .status(400)
        .json({ message: "Please upload a physical file." });
    }

    const normalizedCourseCode = courseCode ? courseCode.toUpperCase() : null;

    // --- External resource link -----------------------------------------
    // No file involved at all: Study2Gate only stores and links to the
    // URL, never fetches, proxies, or executes anything from it. Since
    // there's no file content to run the copyright/duplicate scanner
    // against, external resources publish immediately as CLEARED — the
    // same admin moderation tools (restrict/remove) used for uploaded
    // files remain available if a link turns out to be inappropriate.
    if (sourceType === "EXTERNAL_LINK") {
      let normalizedUrl;
      let domain;
      try {
        ({ normalizedUrl, domain } = validateExternalUrl(externalUrl));
      } catch (validationError) {
        return res.status(400).json({ message: validationError.message });
      }

      try {
        const newFile = await prisma.file.create({
          data: {
            title,
            description,
            courseCode: normalizedCourseCode,
            type,
            sourceType: "EXTERNAL_LINK",
            externalUrl: normalizedUrl,
            externalDomain: domain,
            uploadedBy: req.user.id,
            uploaderName:
              req.user.showUsernameOnMaterials === false
                ? "Anonymous"
                : req.user.username,
            copyrightConfirmedAt: new Date(),
            copyrightConfirmationVersion: COPYRIGHT_CONFIRMATION_VERSION,
            copyrightScanStatus: "APPROVED",
            copyrightStatus: "CLEARED",
            reviewRequired: false,
          },
        });

        return res.status(201).json({
          ...newFile,
          uploaderName: req.user.showUsernameOnMaterials
            ? req.user.username
            : null,
        });
      } catch (error) {
        console.error("External resource creation error:", error);
        return res.status(500).json({
          message: "Unable to save this resource right now. Please try again.",
        });
      }
    }

    // --- Uploaded file -----------------------------------------------------
    let objectKey = null;

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

      // The File row and the +2 download-credit award are created together
      // in one transaction: a successful upload (this is what "successful"
      // means here — the record is persisted, independent of whether it's
      // CLEARED or held for copyright review) always earns credits, and a
      // failed one (an error below rolls back before this point is
      // reached, or throws) never does.
      const [newFile, creditedUser] = await prisma.$transaction([
        prisma.file.create({
          data: {
            title,
            description,
            courseCode: normalizedCourseCode,
            type,
            sourceType: "UPLOAD",
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
        }),
        prisma.user.update({
          where: { id: req.user.id },
          data: { downloadCredits: { increment: CREDITS_PER_UPLOAD } },
          select: { downloadCredits: true },
        }),
      ]);

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
        downloadCredits: creditedUser.downloadCredits,
        creditsAwarded: CREDITS_PER_UPLOAD,
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

    if (file.sourceType === "EXTERNAL_LINK") {
      return res.status(400).json({
        message:
          "This is an external resource — open it at its original source instead of downloading it from Study2Gate.",
      });
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

    // --- Download credits --------------------------------------------
    // Admins bypass the credit system entirely — this mirrors the existing
    // admin bypass in isVisibleToViewer above (e.g. retrieving a file for
    // copyright review isn't "a user downloading study material").
    const isAdmin = req.user.role === "admin";
    let creditSpent = false;

    if (!isAdmin) {
      // Atomic, DB-enforced check-and-spend: this only decrements when the
      // balance is currently above 0, in the same database operation as
      // the check, so two concurrent download requests (or a client
      // racing the request) can never drive the balance negative — the
      // database is the sole source of truth, not anything the client
      // sends.
      const spend = await prisma.user.updateMany({
        where: { id: req.user.id, downloadCredits: { gt: 0 } },
        data: { downloadCredits: { decrement: DOWNLOAD_CREDIT_COST } },
      });

      if (spend.count === 0) {
        return res.status(402).json({
          message: "You're out of download credits.",
          code: "INSUFFICIENT_CREDITS",
        });
      }
      creditSpent = true;
    }

    // If anything below fails before the file is actually handed to the
    // user, the spent credit is handed back — a failed download must never
    // cost a credit.
    const refundSpentCredit = async () => {
      if (!creditSpent) return;
      creditSpent = false;
      await prisma.user
        .update({
          where: { id: req.user.id },
          data: { downloadCredits: { increment: DOWNLOAD_CREDIT_COST } },
        })
        .catch((refundError) =>
          console.error("Download credit refund failed:", refundError)
        );
    };

    const currentCredits = async () => {
      if (isAdmin) return null;
      const record = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { downloadCredits: true },
      });
      return record?.downloadCredits ?? null;
    };

    // Backward compatibility for files that were stored on Render before B2.
    if (file.filepath.startsWith("uploads/") && fs.existsSync(file.filepath)) {
      await prisma.file.update({
        where: { id: fileId },
        data: { downloads: { increment: 1 } },
      });

      const remaining = await currentCredits();
      if (remaining !== null) res.setHeader("X-Download-Credits", String(remaining));

      return res.download(
        file.filepath,
        file.title + path.extname(file.filename),
        (downloadError) => {
          if (downloadError) refundSpentCredit();
        }
      );
    }

    let b2File;
    try {
      b2File = await getFromB2(file.filepath);
    } catch (fetchError) {
      await refundSpentCredit();
      throw fetchError;
    }

    await prisma.file.update({
      where: { id: fileId },
      data: { downloads: { increment: 1 } },
    });

    const remaining = await currentCredits();

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
    if (remaining !== null) res.setHeader("X-Download-Credits", String(remaining));
    // The Content-Disposition/X-Download-Credits headers above aren't
    // reachable by JS on a cross-origin response unless explicitly
    // exposed — the frontend reads X-Download-Credits after every
    // download to keep the Navbar balance in sync.
    res.setHeader("Access-Control-Expose-Headers", "X-Download-Credits");

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
