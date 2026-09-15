import prisma from "../config/prisma.js";
import { createNotification } from "./circleRealtime.js";
import { sendCopyrightNotificationEmail } from "./email.js";

// Every copyright-moderation notification the app sends goes through here,
// so the wording (see section 16 of the copyright spec) lives in one
// place. In-app notification + push always happen (via createNotification,
// which itself respects the user's notifyAccountSecurity push toggle).
// Email is additive and always best-effort — never throws, never blocks
// the caller.
const TEMPLATES = {
  REVIEW: {
    title: "Material under copyright review",
    body: (fileTitle) =>
      `Your uploaded material "${fileTitle}" is currently under copyright review.`,
  },
  RESTRICTED: {
    title: "Material access restricted",
    body: (fileTitle) =>
      `Access to your uploaded material "${fileTitle}" has been temporarily restricted while we review a copyright concern.`,
  },
  REMOVED: {
    title: "Material removed",
    body: (fileTitle) =>
      `Your uploaded material "${fileTitle}" has been removed following a copyright review.`,
  },
  RESTORED: {
    title: "Material restored",
    body: (fileTitle) =>
      `Your uploaded material "${fileTitle}" has been restored following review.`,
  },
  INFO_REQUESTED: {
    title: "Additional information needed",
    body: (fileTitle) =>
      `We need additional information regarding your uploaded material "${fileTitle}".`,
  },
  WARNED: {
    title: "Copyright warning",
    body: () => `Your account has received a copyright warning. Repeated substantiated copyright complaints can lead to suspension or termination.`,
  },
  SUSPENDED: {
    title: "Account suspended",
    body: (_t, reason) =>
      `Your account has been temporarily suspended${reason ? ` (${reason})` : ""} following a copyright review.`,
  },
  TERMINATED: {
    title: "Account terminated",
    body: (_t, reason) =>
      `Your account has been terminated${reason ? ` (${reason})` : ""} following a copyright review.`,
  },
  CLEARED: {
    title: "Material cleared",
    body: (fileTitle) =>
      `Your uploaded material "${fileTitle}" has cleared copyright review and is now published.`,
  },
  DISPUTE_RECEIVED: {
    title: "Dispute received",
    body: (fileTitle) =>
      `We've received your dispute regarding "${fileTitle}". An administrator will review it.`,
  },
  DISPUTE_DECIDED: {
    title: "Dispute reviewed",
    body: (fileTitle, decision) =>
      `Your dispute regarding "${fileTitle}" has been reviewed. Outcome: ${decision}.`,
  },
};

export const notifyUploaderOfCopyrightEvent = async ({
  userId,
  templateKey,
  fileTitle,
  extra = null,
  fileId = null,
}) => {
  const template = TEMPLATES[templateKey];
  if (!template) throw new Error(`Unknown copyright notification template: ${templateKey}`);

  const body = template.body(fileTitle, extra);

  const notification = await createNotification({
    userId,
    type: "COPYRIGHT",
    title: template.title,
    body,
  });

  if (fileId) {
    await prisma.file.update({
      where: { id: fileId },
      data: { uploaderNotifiedAt: new Date() },
    }).catch(() => {});
  }

  // Best-effort email — never blocks or throws.
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (user?.email) {
      await sendCopyrightNotificationEmail({
        to: user.email,
        subject: `Study2Gate — ${template.title}`,
        heading: template.title,
        message: body,
      });
    }
  } catch (error) {
    console.warn("Copyright notification email failed:", error.message);
  }

  // Also alert the admin the moment a file lands in review, so moderation
  // isn't waiting on someone to notice it in the dashboard. Same Brevo
  // review account/API as the uploader email above — just a second
  // recipient, so it doesn't cost an extra provider or quota to set up.
  if (templateKey === "REVIEW") {
    const adminEmail = process.env.ADMIN_REVIEW_EMAIL;
    if (!adminEmail) {
      // Previously this branch was silently skipped — a missing
      // ADMIN_REVIEW_EMAIL produced zero log output anywhere, making a
      // "why didn't I get an email" report impossible to diagnose from
      // the logs alone. Always leave a trace now.
      console.warn(
        "Admin review notification skipped: ADMIN_REVIEW_EMAIL is not set."
      );
    } else {
      try {
        await sendCopyrightNotificationEmail({
          to: adminEmail,
          subject: `Study2Gate — New upload awaiting review: "${fileTitle}"`,
          heading: "New upload awaiting copyright review",
          message: `"${fileTitle}" (file ID: ${fileId || "n/a"}) was just flagged and is awaiting review.`,
        });
      } catch (error) {
        console.warn("Admin review notification email failed:", error.message);
      }
    }
  }

  return notification;
};
