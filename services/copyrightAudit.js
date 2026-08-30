import prisma from "../config/prisma.js";

// Every significant copyright-moderation action goes through here so the
// audit trail is complete and consistent. Never exposed for
// creation/editing outside admin controllers, and never updated/deleted
// once written (see prisma/schema.prisma — CopyrightAuditLog has no
// update/delete call sites anywhere in the codebase by design).
export const logCopyrightAction = async ({
  adminId,
  action,
  targetFileId = null,
  targetUserId = null,
  reportId = null,
  disputeId = null,
  reason = null,
  previousStatus = null,
  newStatus = null,
}) => {
  try {
    return await prisma.copyrightAuditLog.create({
      data: {
        adminId,
        action,
        targetFileId,
        targetUserId,
        reportId,
        disputeId,
        reason,
        previousStatus,
        newStatus,
      },
    });
  } catch (error) {
    // An audit-log write failure must never block the underlying admin
    // action (the action itself already succeeded/failed independently).
    console.error("Copyright audit log error:", error);
    return null;
  }
};
