import prisma from "../config/prisma.js";
import { logCopyrightAction } from "../services/copyrightAudit.js";
import { notifyUploaderOfCopyrightEvent } from "../services/copyrightNotify.js";
import { createCopyrightReportWithCaseNumber } from "../services/copyrightCaseNumber.js";

// When a file is restored to public view — whether via the direct RESTORE
// action or an upheld dispute — any case records for it that are still
// open should reflect that outcome too, instead of silently drifting out
// of sync with the file itself (e.g. a case sitting at UNDER_REVIEW while
// the file it's about has been public again for weeks). Reports already
// closed out (RESOLVED/REJECTED/CLOSED) are left alone — this only
// touches ones an admin hasn't already made a call on.
async function resolveOpenCasesForRestoredFile({ fileId, reviewerId, note }) {
  const openReports = await prisma.copyrightReport.findMany({
    where: { fileId, status: { notIn: ["RESOLVED", "REJECTED", "CLOSED"] } },
    select: { id: true, status: true },
  });

  for (const report of openReports) {
    const updated = await prisma.copyrightReport.update({
      where: { id: report.id },
      data: {
        status: "RESOLVED",
        decision: note,
        actionTaken: "File restored to public view.",
        reviewedByUserId: reviewerId,
        reviewedAt: new Date(),
      },
    });

    await logCopyrightAction({
      adminId: reviewerId,
      action: "COPYRIGHT_REPORT_AUTO_RESOLVED_ON_RESTORE",
      targetFileId: fileId,
      reportId: report.id,
      reason: note,
      previousStatus: report.status,
      newStatus: updated.status,
    });
  }

  return openReports.length;
}

const FILE_SUMMARY_SELECT = {
  id: true,
  title: true,
  description: true,
  courseCode: true,
  type: true,
  filename: true,
  mimetype: true,
  downloads: true,
  createdAt: true,
  updatedAt: true,
  uploadedBy: true,
  uploaderName: true,
  copyrightStatus: true,
  copyrightRisk: true,
  copyrightScore: true,
  copyrightCheckedAt: true,
  similarityScore: true,
  duplicateOfId: true,
  webMatchFound: true,
  sourceReferences: true,
  reviewRequired: true,
  reviewReason: true,
  reviewedAt: true,
  restrictionReason: true,
  removalReason: true,
  uploaderNotifiedAt: true,
  reportCount: true,
  internalNotesCount: true,
  duplicateOf: { select: { id: true, title: true, copyrightStatus: true } },
  user: { select: { id: true, fullName: true, username: true } },
  reviewedByUser: { select: { id: true, fullName: true, username: true } },
};

// --- Copyright Review Queue ---------------------------------------------

export const getCopyrightQueue = async (req, res) => {
  try {
    const { filter = "all", search = "" } = req.query;

    const where = {};

    switch (filter) {
      case "high":
        where.copyrightRisk = "HIGH";
        where.copyrightStatus = { not: "REJECTED" };
        break;
      case "medium":
        where.copyrightRisk = "MEDIUM";
        where.copyrightStatus = { not: "REJECTED" };
        break;
      case "reported":
        where.reportCount = { gt: 0 };
        break;
      case "restricted":
        where.copyrightStatus = "RESTRICTED";
        break;
      case "removed":
        where.copyrightStatus = "REMOVED";
        break;
      case "cleared":
        where.copyrightStatus = "CLEARED";
        break;
      case "pending":
        where.copyrightStatus = { in: ["PENDING", "REVIEW_REQUIRED"] };
        break;
      case "repeat":
        where.user = { copyrightWarnings: { gt: 0 } };
        break;
      case "all":
      default:
        break;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { courseCode: { contains: search, mode: "insensitive" } },
        { uploaderName: { contains: search, mode: "insensitive" } },
      ];
    }

    const files = await prisma.file.findMany({
      where,
      select: FILE_SUMMARY_SELECT,
      orderBy: [{ copyrightRisk: "desc" }, { createdAt: "desc" }],
      take: 200,
    });

    res.json({ success: true, files });
  } catch (error) {
    console.error("Copyright queue error:", error);
    res.status(500).json({ success: false, message: "Unable to load the copyright review queue." });
  }
};

export const getCopyrightStats = async (req, res) => {
  try {
    const [high, medium, cleared, reported, restricted, removed, pendingReports, pendingDisputes] =
      await Promise.all([
        prisma.file.count({ where: { copyrightRisk: "HIGH", copyrightStatus: { notIn: ["CLEARED", "REJECTED"] } } }),
        prisma.file.count({ where: { copyrightRisk: "MEDIUM", copyrightStatus: { notIn: ["CLEARED", "REJECTED"] } } }),
        prisma.file.count({ where: { copyrightStatus: "CLEARED" } }),
        prisma.file.count({ where: { reportCount: { gt: 0 } } }),
        prisma.file.count({ where: { copyrightStatus: "RESTRICTED" } }),
        prisma.file.count({ where: { copyrightStatus: "REMOVED" } }),
        prisma.copyrightReport.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
        prisma.copyrightDispute.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
      ]);

    res.json({
      success: true,
      stats: { high, medium, cleared, reported, restricted, removed, pendingReports, pendingDisputes },
    });
  } catch (error) {
    console.error("Copyright stats error:", error);
    res.status(500).json({ success: false, message: "Unable to load copyright statistics." });
  }
};

export const getCopyrightFileDetail = async (req, res) => {
  try {
    const fileId = Number(req.params.id);
    if (!Number.isInteger(fileId)) return res.status(400).json({ message: "Invalid file ID." });

    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: {
        ...FILE_SUMMARY_SELECT,
        copyrightReports: { orderBy: { createdAt: "desc" } },
        copyrightDisputes: { orderBy: { createdAt: "desc" } },
        copyrightNotes: {
          orderBy: { createdAt: "desc" },
          include: { author: { select: { id: true, fullName: true, username: true } } },
        },
      },
    });

    if (!file) return res.status(404).json({ message: "File not found." });

    const auditLog = await prisma.copyrightAuditLog.findMany({
      where: { targetFileId: fileId },
      orderBy: { createdAt: "desc" },
      include: { admin: { select: { id: true, fullName: true, username: true } } },
    });

    // Uploader's broader copyright history, so the admin can see whether
    // this is a first-time flag or part of a pattern (section 12).
    const uploaderHistory = await getUploaderHistory(file.uploadedBy);

    res.json({ success: true, file, auditLog, uploaderHistory });
  } catch (error) {
    console.error("Copyright file detail error:", error);
    res.status(500).json({ success: false, message: "Unable to load file details." });
  }
};

const getUploaderHistory = async (userId) => {
  const [user, reportsAgainst, substantiatedReports, restrictedCount, removedCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        username: true,
        copyrightWarnings: true,
        suspendedAt: true,
        suspendedUntil: true,
        suspendedReason: true,
        terminatedAt: true,
        terminatedReason: true,
      },
    }),
    prisma.copyrightReport.count({ where: { file: { uploadedBy: userId } } }),
    prisma.copyrightReport.count({ where: { file: { uploadedBy: userId }, outcome: "LEGITIMATE" } }),
    prisma.file.count({ where: { uploadedBy: userId, copyrightStatus: "RESTRICTED" } }),
    prisma.file.count({ where: { uploadedBy: userId, copyrightStatus: "REMOVED" } }),
  ]);

  return { user, reportsAgainst, substantiatedReports, restrictedCount, removedCount };
};

export const getUploaderCopyrightHistory = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) return res.status(400).json({ message: "Invalid user ID." });

    const history = await getUploaderHistory(userId);
    if (!history.user) return res.status(404).json({ message: "User not found." });

    const actions = await prisma.copyrightAuditLog.findMany({
      where: { targetUserId: userId },
      orderBy: { createdAt: "desc" },
      include: { admin: { select: { id: true, fullName: true, username: true } } },
    });

    res.json({ success: true, ...history, actions });
  } catch (error) {
    console.error("Uploader copyright history error:", error);
    res.status(500).json({ success: false, message: "Unable to load uploader history." });
  }
};

// --- File-level admin actions -------------------------------------------

const FILE_ACTIONS = {
  CLEAR: "FILE_CLEARED",
  RESTRICT: "FILE_RESTRICTED",
  REMOVE: "FILE_REMOVED",
  RESTORE: "FILE_RESTORED",
  REQUEST_INFO: "FILE_INFO_REQUESTED",
};

export const performCopyrightFileAction = async (req, res) => {
  try {
    const fileId = Number(req.params.id);
    const { action, reason = "" } = req.body;

    if (!Number.isInteger(fileId)) return res.status(400).json({ message: "Invalid file ID." });
    if (!FILE_ACTIONS[action]) {
      return res.status(400).json({
        message: `Action must be one of: ${Object.keys(FILE_ACTIONS).join(", ")}.`,
      });
    }

    const file = await prisma.file.findUnique({ where: { id: fileId } });
    if (!file) return res.status(404).json({ message: "File not found." });

    const previousStatus = file.copyrightStatus;
    const updateData = {
      reviewedByUserId: req.user.id,
      reviewedAt: new Date(),
    };
    let notifyTemplate = null;

    switch (action) {
      case "CLEAR":
        updateData.copyrightStatus = "CLEARED";
        updateData.reviewRequired = false;
        updateData.reviewReason = null;
        notifyTemplate = "CLEARED";
        break;
      case "RESTRICT":
        updateData.copyrightStatus = "RESTRICTED";
        updateData.restrictionReason = reason || "Under copyright review.";
        notifyTemplate = "RESTRICTED";
        break;
      case "REMOVE":
        // Soft delete: the record and B2 object are kept, only the
        // publication status changes, so a wrongly-removed file can
        // still be fully restored later (section 8: "prefer reversible
        // status changes... instead of immediately destroying records").
        updateData.copyrightStatus = "REMOVED";
        updateData.removalReason = reason || "Removed following copyright review.";
        notifyTemplate = "REMOVED";
        break;
      case "RESTORE":
        updateData.copyrightStatus = "CLEARED";
        updateData.restrictionReason = null;
        updateData.removalReason = null;
        updateData.reviewRequired = false;
        notifyTemplate = "RESTORED";
        break;
      case "REQUEST_INFO":
        updateData.reviewReason = reason || "Additional information requested.";
        notifyTemplate = "INFO_REQUESTED";
        break;
      default:
        break;
    }

    const updated = await prisma.file.update({ where: { id: fileId }, data: updateData });

    await logCopyrightAction({
      adminId: req.user.id,
      action: FILE_ACTIONS[action],
      targetFileId: fileId,
      targetUserId: file.uploadedBy,
      reason: reason || null,
      previousStatus,
      newStatus: updated.copyrightStatus,
    });

    if (notifyTemplate) {
      await notifyUploaderOfCopyrightEvent({
        userId: file.uploadedBy,
        templateKey: notifyTemplate,
        fileTitle: file.title,
        fileId,
      }).catch((error) => console.warn("Copyright notify failed:", error.message));
    }

    let resolvedReportsCount = 0;
    if (action === "RESTORE") {
      resolvedReportsCount = await resolveOpenCasesForRestoredFile({
        fileId,
        reviewerId: req.user.id,
        note: reason || "File restored — found to have legal basis to share.",
      });
    }

    res.json({
      success: true,
      message: `Action "${action}" applied.${resolvedReportsCount ? ` ${resolvedReportsCount} related case(s) marked resolved.` : ""}`,
      file: updated,
      resolvedReportsCount,
    });
  } catch (error) {
    console.error("Copyright file action error:", error);
    res.status(500).json({ success: false, message: "Unable to perform this action." });
  }
};

export const addCopyrightNote = async (req, res) => {
  try {
    const fileId = Number(req.params.id);
    const { note } = req.body;

    if (!Number.isInteger(fileId)) return res.status(400).json({ message: "Invalid file ID." });
    if (!note || !note.trim()) return res.status(400).json({ message: "Note cannot be empty." });

    const file = await prisma.file.findUnique({ where: { id: fileId }, select: { id: true } });
    if (!file) return res.status(404).json({ message: "File not found." });

    const created = await prisma.copyrightNote.create({
      data: { fileId, authorId: req.user.id, note: note.trim().slice(0, 4000) },
      include: { author: { select: { id: true, fullName: true, username: true } } },
    });

    await prisma.file.update({ where: { id: fileId }, data: { internalNotesCount: { increment: 1 } } });

    res.status(201).json({ success: true, note: created });
  } catch (error) {
    console.error("Add copyright note error:", error);
    res.status(500).json({ success: false, message: "Unable to add note." });
  }
};

// --- Account-level enforcement -------------------------------------------

export const performCopyrightUserAction = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { action, reason = "", suspendDays } = req.body;

    if (!Number.isInteger(userId)) return res.status(400).json({ message: "Invalid user ID." });

    const validActions = ["WARN", "SUSPEND", "UNSUSPEND", "TERMINATE"];
    if (!validActions.includes(action)) {
      return res.status(400).json({ message: `Action must be one of: ${validActions.join(", ")}.` });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ message: "You cannot take enforcement action against your own account." });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found." });

    if (user.role === "admin") {
      return res.status(400).json({ message: "Administrator accounts cannot be enforced against here." });
    }

    const updateData = {};
    let auditAction = "";
    let notifyTemplate = null;

    if (action === "WARN") {
      updateData.copyrightWarnings = { increment: 1 };
      auditAction = "UPLOADER_WARNED";
      notifyTemplate = "WARNED";
    } else if (action === "SUSPEND") {
      const days = Number.isFinite(Number(suspendDays)) && Number(suspendDays) > 0 ? Number(suspendDays) : 7;
      updateData.suspendedAt = new Date();
      updateData.suspendedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      updateData.suspendedReason = reason || "Copyright policy violation.";
      auditAction = "USER_SUSPENDED";
      notifyTemplate = "SUSPENDED";
    } else if (action === "UNSUSPEND") {
      updateData.suspendedAt = null;
      updateData.suspendedUntil = null;
      updateData.suspendedReason = null;
      auditAction = "USER_UNSUSPENDED";
    } else if (action === "TERMINATE") {
      updateData.terminatedAt = new Date();
      updateData.terminatedReason = reason || "Repeated or serious copyright infringement.";
      auditAction = "USER_TERMINATED";
      notifyTemplate = "TERMINATED";
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true, fullName: true, username: true, copyrightWarnings: true,
        suspendedAt: true, suspendedUntil: true, suspendedReason: true,
        terminatedAt: true, terminatedReason: true,
      },
    });

    await logCopyrightAction({
      adminId: req.user.id,
      action: auditAction,
      targetUserId: userId,
      reason: reason || null,
    });

    if (notifyTemplate) {
      await notifyUploaderOfCopyrightEvent({
        userId,
        templateKey: notifyTemplate,
        fileTitle: "",
        extra: reason || null,
      }).catch((error) => console.warn("Copyright notify failed:", error.message));
    }

    res.json({ success: true, message: `Action "${action}" applied to ${updated.username}.`, user: updated });
  } catch (error) {
    console.error("Copyright user action error:", error);
    res.status(500).json({ success: false, message: "Unable to perform this account action." });
  }
};

// --- Copyright Reports (complaints) --------------------------------------

export const getCopyrightReports = async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? { status } : {};

    const reports = await prisma.copyrightReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        file: { select: { id: true, title: true, uploadedBy: true, uploaderName: true, copyrightStatus: true } },
        reviewedByUser: { select: { id: true, fullName: true, username: true } },
      },
      take: 200,
    });

    res.json({ success: true, reports });
  } catch (error) {
    console.error("Copyright reports list error:", error);
    res.status(500).json({ success: false, message: "Unable to load copyright reports." });
  }
};

// Manually open a case — for complaints that didn't come through the
// in-app report form (email, postal notice, etc). The file/uploader/hash
// are pulled in automatically from the chosen File; only the parts the
// backend genuinely can't know (who complained, what they said) are
// typed in by the admin. Deliberately does NOT touch File.copyrightStatus
// — status changes always go through performCopyrightFileAction, the same
// as they do for user-submitted reports (see decideCopyrightReport below,
// which also never touches file status). Keeping "case record" and
// "publication action" as two separate steps avoids two code paths doing
// overlapping, possibly-inconsistent things.
export const createManualCopyrightCase = async (req, res) => {
  try {
    const {
      fileId,
      complainantName,
      complainantEmail,
      complainantPhone,
      copyrightedWork,
      infringingLocation,
      explanation,
      ownershipEvidence,
      supportingInfo,
      receivedAt,
      status,
      reason,
      decision,
      actionTaken,
      uploaderNotifiedAt,
      uploaderResponse,
    } = req.body;

    const fileIdNum = Number(fileId);
    if (!Number.isInteger(fileIdNum)) return res.status(400).json({ message: "A valid file ID is required." });
    if (!complainantName?.trim() || !complainantEmail?.trim() || !copyrightedWork?.trim() || !explanation?.trim()) {
      return res.status(400).json({
        message: "Please provide the complainant's name, contact email, the copyrighted work, and an explanation.",
      });
    }

    const file = await prisma.file.findUnique({
      where: { id: fileIdNum },
      select: { id: true, title: true, filename: true, contentHash: true, uploadedBy: true, uploaderName: true },
    });
    if (!file) return res.status(404).json({ message: "File not found." });

    const uploaderAccount = file.uploadedBy
      ? await prisma.user.findUnique({ where: { id: file.uploadedBy }, select: { username: true } })
      : null;

    let parsedReceivedAt;
    if (receivedAt) {
      parsedReceivedAt = new Date(receivedAt);
      if (Number.isNaN(parsedReceivedAt.getTime())) {
        return res.status(400).json({ message: "receivedAt is not a valid date." });
      }
    }

    const validStatuses = ["PENDING", "UNDER_REVIEW", "ACTION_TAKEN", "REJECTED", "RESOLVED", "CLOSED"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ message: `Status must be one of: ${validStatuses.join(", ")}.` });
    }

    const report = await createCopyrightReportWithCaseNumber({
      fileId: fileIdNum,
      source: "MANUAL",
      fileTitleSnapshot: file.title,
      fileFilenameSnapshot: file.filename,
      fileHashSnapshot: file.contentHash,
      uploaderId: file.uploadedBy,
      uploaderNameSnapshot: file.uploaderName || null,
      uploaderUsernameSnapshot: uploaderAccount?.username || null,
      complainantName: complainantName.trim().slice(0, 200),
      complainantEmail: complainantEmail.trim().slice(0, 200),
      complainantPhone: complainantPhone?.trim().slice(0, 60) || null,
      copyrightedWork: copyrightedWork.trim().slice(0, 500),
      infringingLocation: infringingLocation?.trim().slice(0, 500) || null,
      explanation: explanation.trim().slice(0, 4000),
      ownershipEvidence: ownershipEvidence?.trim().slice(0, 2000) || null,
      supportingInfo: supportingInfo?.trim().slice(0, 2000) || null,
      declarationAccepted: true,
      status: status || "PENDING",
      reason: reason?.trim().slice(0, 2000) || null,
      decision: decision?.trim().slice(0, 2000) || null,
      actionTaken: actionTaken?.trim().slice(0, 500) || null,
      uploaderNotifiedAt: uploaderNotifiedAt ? new Date(uploaderNotifiedAt) : null,
      uploaderResponse: uploaderResponse?.trim().slice(0, 4000) || null,
      ...(parsedReceivedAt ? { createdAt: parsedReceivedAt } : {}),
    });

    await prisma.file.update({ where: { id: fileIdNum }, data: { reportCount: { increment: 1 } } });

    await logCopyrightAction({
      adminId: req.user.id,
      action: "COPYRIGHT_CASE_CREATED_MANUALLY",
      targetFileId: fileIdNum,
      targetUserId: file.uploadedBy,
      reportId: report.id,
      reason: "Manually recorded complaint.",
      newStatus: report.status,
    });

    res.status(201).json({ success: true, report });
  } catch (error) {
    console.error("Create manual copyright case error:", error);
    res.status(500).json({ success: false, message: "Unable to create this case." });
  }
};

export const decideCopyrightReport = async (req, res) => {
  try {
    const reportId = Number(req.params.id);
    const {
      status,
      outcome,
      decision,
      actionTaken,
      reason,
      uploaderNotifiedAt,
      uploaderResponse,
      complainantName,
      complainantEmail,
      complainantPhone,
      copyrightedWork,
      infringingLocation,
    } = req.body;

    if (!Number.isInteger(reportId)) return res.status(400).json({ message: "Invalid report ID." });

    const validStatuses = ["PENDING", "UNDER_REVIEW", "ACTION_TAKEN", "REJECTED", "RESOLVED", "CLOSED"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ message: `Status must be one of: ${validStatuses.join(", ")}.` });
    }

    const validOutcomes = ["LEGITIMATE", "UNFOUNDED", "INSUFFICIENT_INFORMATION", "FALSE_OR_MISLEADING"];
    if (outcome && !validOutcomes.includes(outcome)) {
      return res.status(400).json({ message: `Outcome must be one of: ${validOutcomes.join(", ")}.` });
    }

    const report = await prisma.copyrightReport.findUnique({ where: { id: reportId } });
    if (!report) return res.status(404).json({ message: "Report not found." });

    // uploaderNotifiedAt accepts an explicit `null` to clear a mistaken
    // entry, so it's handled separately from the `?? report.x` pattern
    // used for fields where "not sent" and "clear it" aren't distinguishable.
    const uploaderNotifiedAtValue =
      uploaderNotifiedAt === undefined
        ? report.uploaderNotifiedAt
        : uploaderNotifiedAt === null
        ? null
        : new Date(uploaderNotifiedAt);

    const updated = await prisma.copyrightReport.update({
      where: { id: reportId },
      data: {
        status: status || report.status,
        outcome: outcome ?? report.outcome,
        decision: decision ?? report.decision,
        actionTaken: actionTaken ?? report.actionTaken,
        reason: reason ?? report.reason,
        uploaderNotifiedAt: uploaderNotifiedAtValue,
        uploaderResponse: uploaderResponse ?? report.uploaderResponse,
        complainantName: complainantName?.trim().slice(0, 200) || report.complainantName,
        complainantEmail: complainantEmail?.trim().slice(0, 200) || report.complainantEmail,
        complainantPhone: complainantPhone !== undefined ? complainantPhone?.trim().slice(0, 60) || null : report.complainantPhone,
        copyrightedWork: copyrightedWork?.trim().slice(0, 500) || report.copyrightedWork,
        infringingLocation: infringingLocation !== undefined ? infringingLocation?.trim().slice(0, 500) || null : report.infringingLocation,
        reviewedByUserId: req.user.id,
        reviewedAt: new Date(),
      },
    });

    await logCopyrightAction({
      adminId: req.user.id,
      action: status === "REJECTED" ? "COPYRIGHT_REPORT_REJECTED" : "COPYRIGHT_REVIEW_COMPLETED",
      targetFileId: report.fileId,
      reportId,
      reason: reason || null,
      previousStatus: report.status,
      newStatus: updated.status,
    });

    res.json({ success: true, report: updated });
  } catch (error) {
    console.error("Decide copyright report error:", error);
    res.status(500).json({ success: false, message: "Unable to update this report." });
  }
};

// Assembles one case into the full readable record: complaint,
// complainant, file/uploader (live if the file still exists, snapshot if
// not), notification + response, final decision, and the audit trail —
// matching a standard takedown-case-log format.
export const getCopyrightCaseRecord = async (req, res) => {
  try {
    const reportId = Number(req.params.id);
    if (!Number.isInteger(reportId)) return res.status(400).json({ message: "Invalid report ID." });

    const report = await prisma.copyrightReport.findUnique({
      where: { id: reportId },
      include: {
        file: { select: { id: true, title: true, filename: true, contentHash: true, copyrightStatus: true, uploadedBy: true } },
        complainantUser: { select: { id: true, fullName: true, username: true } },
        reviewedByUser: { select: { id: true, fullName: true, username: true } },
      },
    });
    if (!report) return res.status(404).json({ message: "Case not found." });

    const auditEntries = await prisma.copyrightAuditLog.findMany({
      where: { reportId },
      orderBy: { createdAt: "asc" },
      include: { admin: { select: { id: true, fullName: true, username: true } } },
    });

    const fileStillExists = Boolean(report.file);

    res.json({
      success: true,
      record: {
        caseId: report.caseNumber,
        source: report.source,
        complainant: {
          name: report.complainantName,
          email: report.complainantEmail,
          phone: report.complainantPhone,
          account: report.complainantUser || null,
        },
        copyrightedWork: report.copyrightedWork,
        file: {
          id: report.fileId,
          title: fileStillExists ? report.file.title : report.fileTitleSnapshot,
          filename: fileStillExists ? report.file.filename : report.fileFilenameSnapshot,
          exists: fileStillExists,
          currentStatus: fileStillExists ? report.file.copyrightStatus : null,
        },
        uploader: {
          id: report.uploaderId,
          name: report.uploaderNameSnapshot,
          username: report.uploaderUsernameSnapshot,
        },
        complaintReceivedAt: report.createdAt,
        action: report.actionTaken,
        uploaderNotifiedAt: report.uploaderNotifiedAt,
        uploaderResponse: report.uploaderResponse,
        status: report.status,
        finalDecision: report.decision,
        reason: report.reason,
        hash: fileStillExists ? report.file.contentHash : report.fileHashSnapshot,
        reviewedBy: report.reviewedByUser || null,
        reviewedAt: report.reviewedAt,
        updatedAt: report.updatedAt,
        auditTrail: auditEntries,
      },
    });
  } catch (error) {
    console.error("Copyright case record error:", error);
    res.status(500).json({ success: false, message: "Unable to load this case record." });
  }
};

// --- Disputes (counter-notices) ------------------------------------------

export const getCopyrightDisputes = async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? { status } : {};

    const disputes = await prisma.copyrightDispute.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        file: { select: { id: true, title: true, copyrightStatus: true, restrictionReason: true, removalReason: true } },
        uploader: { select: { id: true, fullName: true, username: true } },
        reviewedByUser: { select: { id: true, fullName: true, username: true } },
      },
      take: 200,
    });

    res.json({ success: true, disputes });
  } catch (error) {
    console.error("Copyright disputes list error:", error);
    res.status(500).json({ success: false, message: "Unable to load disputes." });
  }
};

export const decideCopyrightDispute = async (req, res) => {
  try {
    const disputeId = Number(req.params.id);
    const { status, adminResponse, restore } = req.body;

    if (!Number.isInteger(disputeId)) return res.status(400).json({ message: "Invalid dispute ID." });

    const validStatuses = ["PENDING", "UNDER_REVIEW", "UPHELD", "RESTORED", "CLOSED"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ message: `Status must be one of: ${validStatuses.join(", ")}.` });
    }

    const dispute = await prisma.copyrightDispute.findUnique({ where: { id: disputeId }, include: { file: true } });
    if (!dispute) return res.status(404).json({ message: "Dispute not found." });

    const updated = await prisma.copyrightDispute.update({
      where: { id: disputeId },
      data: {
        status,
        adminResponse: adminResponse ?? dispute.adminResponse,
        reviewedByUserId: req.user.id,
        reviewedAt: new Date(),
      },
    });

    // Restoring content is never automatic (section 11) — it only happens
    // here, when an administrator explicitly sets status=RESTORED (or
    // passes restore:true alongside it).
    if (status === "RESTORED" && restore !== false) {
      const previousStatus = dispute.file.copyrightStatus;
      await prisma.file.update({
        where: { id: dispute.fileId },
        data: {
          copyrightStatus: "CLEARED",
          restrictionReason: null,
          removalReason: null,
          reviewRequired: false,
          reviewedByUserId: req.user.id,
          reviewedAt: new Date(),
        },
      });

      await logCopyrightAction({
        adminId: req.user.id,
        action: "FILE_RESTORED",
        targetFileId: dispute.fileId,
        targetUserId: dispute.uploaderId,
        disputeId,
        reason: adminResponse || "Dispute upheld — material restored.",
        previousStatus,
        newStatus: "CLEARED",
      });

      await resolveOpenCasesForRestoredFile({
        fileId: dispute.fileId,
        reviewerId: req.user.id,
        note: adminResponse || "Dispute upheld — material restored.",
      });
    }

    await logCopyrightAction({
      adminId: req.user.id,
      action: `DISPUTE_${status}`,
      targetFileId: dispute.fileId,
      targetUserId: dispute.uploaderId,
      disputeId,
      reason: adminResponse || null,
      previousStatus: dispute.status,
      newStatus: status,
    });

    await notifyUploaderOfCopyrightEvent({
      userId: dispute.uploaderId,
      templateKey: "DISPUTE_DECIDED",
      fileTitle: dispute.file.title,
      extra: status === "RESTORED" ? "material restored" : status === "UPHELD" ? "restriction upheld" : status.toLowerCase(),
      fileId: dispute.fileId,
    }).catch((error) => console.warn("Copyright notify failed:", error.message));

    res.json({ success: true, dispute: updated });
  } catch (error) {
    console.error("Decide copyright dispute error:", error);
    res.status(500).json({ success: false, message: "Unable to update this dispute." });
  }
};

// --- Audit log -------------------------------------------------------------

export const getCopyrightAuditLog = async (req, res) => {
  try {
    const { fileId, userId } = req.query;
    const where = {};
    if (fileId) where.targetFileId = Number(fileId);
    if (userId) where.targetUserId = Number(userId);

    const entries = await prisma.copyrightAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { admin: { select: { id: true, fullName: true, username: true } } },
      take: 300,
    });

    res.json({ success: true, entries });
  } catch (error) {
    console.error("Copyright audit log error:", error);
    res.status(500).json({ success: false, message: "Unable to load the audit log." });
  }
};
