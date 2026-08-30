import prisma from "../config/prisma.js";
import { notifyUploaderOfCopyrightEvent } from "../services/copyrightNotify.js";
import { createCopyrightReportWithCaseNumber } from "../services/copyrightCaseNumber.js";

// Anyone signed in can report a file — the reporter does not need to be
// its uploader, a circle member, or otherwise connected to it, matching
// "For each file, where appropriate, provide Report Copyright
// Infringement" (section 9). Login is required only because the whole
// app already requires it (see routes/files.js), not because of anything
// copyright-specific.
export const submitCopyrightReport = async (req, res) => {
  try {
    const fileId = Number(req.params.id);
    const {
      complainantName,
      complainantEmail,
      complainantPhone,
      copyrightedWork,
      infringingLocation,
      explanation,
      ownershipEvidence,
      supportingInfo,
      declarationAccepted,
    } = req.body;

    if (!Number.isInteger(fileId)) return res.status(400).json({ message: "Invalid file ID." });

    if (!complainantName?.trim() || !complainantEmail?.trim() || !copyrightedWork?.trim() || !explanation?.trim()) {
      return res.status(400).json({
        message: "Please provide your name, contact email, the copyrighted work, and an explanation.",
      });
    }

    if (!declarationAccepted) {
      return res.status(400).json({
        message: "You must confirm the information is accurate to the best of your knowledge.",
      });
    }

    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, title: true, filename: true, contentHash: true, uploadedBy: true, uploaderName: true },
    });
    if (!file) return res.status(404).json({ message: "File not found." });

    const uploaderAccount = file.uploadedBy
      ? await prisma.user.findUnique({ where: { id: file.uploadedBy }, select: { username: true } })
      : null;

    const report = await createCopyrightReportWithCaseNumber({
      fileId,
      source: "USER_SUBMITTED",
      fileTitleSnapshot: file.title,
      fileFilenameSnapshot: file.filename,
      fileHashSnapshot: file.contentHash,
      uploaderId: file.uploadedBy,
      uploaderNameSnapshot: file.uploaderName || null,
      uploaderUsernameSnapshot: uploaderAccount?.username || null,
      complainantUserId: req.user.id,
      complainantName: complainantName.trim().slice(0, 200),
      complainantEmail: complainantEmail.trim().slice(0, 200),
      complainantPhone: complainantPhone?.trim().slice(0, 60) || null,
      copyrightedWork: copyrightedWork.trim().slice(0, 500),
      infringingLocation: infringingLocation?.trim().slice(0, 500) || null,
      explanation: explanation.trim().slice(0, 4000),
      ownershipEvidence: ownershipEvidence?.trim().slice(0, 2000) || null,
      supportingInfo: supportingInfo?.trim().slice(0, 2000) || null,
      declarationAccepted: true,
    });

    await prisma.file.update({ where: { id: fileId }, data: { reportCount: { increment: 1 } } });

    res.status(201).json({
      success: true,
      message: "Your report has been submitted. Study2Gate's administrators will review it.",
      reportId: report.id,
    });
  } catch (error) {
    console.error("Submit copyright report error:", error);
    res.status(500).json({ success: false, message: "Unable to submit this report." });
  }
};

// The uploader's counter-notice against a RESTRICTED/REMOVED file
// (section 11). Only the uploader of that specific file can dispute it.
export const submitCopyrightDispute = async (req, res) => {
  try {
    const fileId = Number(req.params.id);
    const { explanation, ownsWork, hasPermission, otherLawfulBasis } = req.body;

    if (!Number.isInteger(fileId)) return res.status(400).json({ message: "Invalid file ID." });
    if (!explanation?.trim()) {
      return res.status(400).json({ message: "Please explain why you believe you have the right to use this material." });
    }

    const file = await prisma.file.findUnique({ where: { id: fileId } });
    if (!file) return res.status(404).json({ message: "File not found." });

    if (file.uploadedBy !== req.user.id) {
      return res.status(403).json({ message: "Only the uploader can dispute an action taken on this material." });
    }

    if (!["RESTRICTED", "REMOVED"].includes(file.copyrightStatus)) {
      return res.status(400).json({ message: "This material is not currently restricted or removed." });
    }

    const existingOpenDispute = await prisma.copyrightDispute.findFirst({
      where: { fileId, status: { in: ["PENDING", "UNDER_REVIEW"] } },
    });
    if (existingOpenDispute) {
      return res.status(409).json({ message: "You already have an open dispute for this material." });
    }

    const dispute = await prisma.copyrightDispute.create({
      data: {
        fileId,
        uploaderId: req.user.id,
        explanation: explanation.trim().slice(0, 4000),
        ownsWork: Boolean(ownsWork),
        hasPermission: Boolean(hasPermission),
        otherLawfulBasis: otherLawfulBasis?.trim().slice(0, 2000) || null,
      },
    });

    await notifyUploaderOfCopyrightEvent({
      userId: req.user.id,
      templateKey: "DISPUTE_RECEIVED",
      fileTitle: file.title,
      fileId,
    }).catch((error) => console.warn("Copyright notify failed:", error.message));

    res.status(201).json({ success: true, message: "Your dispute has been submitted for review.", dispute });
  } catch (error) {
    console.error("Submit copyright dispute error:", error);
    res.status(500).json({ success: false, message: "Unable to submit this dispute." });
  }
};

// Lets the uploader (or an admin) see a single file's current copyright
// status/reasoning — used to render the "why is my file held" banner.
export const getFileCopyrightStatus = async (req, res) => {
  try {
    const fileId = Number(req.params.id);
    if (!Number.isInteger(fileId)) return res.status(400).json({ message: "Invalid file ID." });

    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        title: true,
        uploadedBy: true,
        copyrightStatus: true,
        copyrightRisk: true,
        reviewReason: true,
        restrictionReason: true,
        removalReason: true,
      },
    });

    if (!file) return res.status(404).json({ message: "File not found." });

    if (file.uploadedBy !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorised." });
    }

    const openDispute = await prisma.copyrightDispute.findFirst({
      where: { fileId, status: { in: ["PENDING", "UNDER_REVIEW"] } },
      select: { id: true, status: true, createdAt: true },
    });

    res.json({ success: true, file, openDispute });
  } catch (error) {
    console.error("Get file copyright status error:", error);
    res.status(500).json({ success: false, message: "Unable to load copyright status." });
  }
};
