// Reusable push-notification sending logic, kept separate from the
// controllers/routes that trigger it (see 20260825160000_add_push_notifications
// migration and circleRealtime.js for where this gets called from).
//
// Nothing outside this file talks to firebase-admin directly — controllers
// and other services only ever call the functions exported here.

import prisma from "../config/prisma.js";
import { getMessaging } from "../config/firebaseAdmin.js";

const MAX_DEVICE_INFO_LENGTH = 200;

// Maps an in-app Notification "type" (see circleRealtime.js / Prisma
// schema) to the Settings → Notifications category the user controls, and
// to where clicking the resulting push notification should navigate.
// Add a new row here whenever a new notification type is introduced
// elsewhere in the app — nothing else needs to change for it to start
// respecting the user's push preferences.
const NOTIFICATION_TYPE_CONFIG = {
  CIRCLE_NEW_MESSAGES: {
    category: "notifyCircleMessages",
    urlFor: (n) => (n.circleId ? `/circles/${n.circleId}` : "/circles"),
  },
  CIRCLE_INVITATION: {
    category: "notifyCircleInvitations",
    urlFor: () => "/circles",
  },
  CIRCLE_JOIN_REQUEST: {
    category: "notifyCircleActivity",
    urlFor: (n) => (n.circleId ? `/circles/${n.circleId}` : "/circles"),
  },
  CIRCLE_JOIN_APPROVED: {
    category: "notifyCircleActivity",
    urlFor: (n) => (n.circleId ? `/circles/${n.circleId}` : "/circles"),
  },
  CIRCLE_JOIN_DECLINED: {
    category: "notifyCircleActivity",
    urlFor: () => "/circles",
  },
  CIRCLE_MEMBER_REMOVED: {
    category: "notifyCircleActivity",
    urlFor: () => "/circles",
  },
  CIRCLE_SESSION_SCHEDULED: {
    category: "notifyCircleActivity",
    urlFor: (n) => (n.circleId ? `/circles/${n.circleId}` : "/circles"),
  },
  MENTION: {
    category: "notifyMentions",
    urlFor: (n) => (n.circleId ? `/circles/${n.circleId}` : "/circles"),
  },
  FLASHCARD_ACTIVITY: {
    category: "notifyFlashcardActivity",
    urlFor: () => "/my-flashcards",
  },
  ACCOUNT_SECURITY: {
    category: "notifyAccountSecurity",
    urlFor: () => "/settings",
  },
  ANNOUNCEMENT: {
    category: "notifyAnnouncements",
    urlFor: () => "/dashboard",
  },
};

const configFor = (type) => NOTIFICATION_TYPE_CONFIG[type] || null;

// --- Device registration -----------------------------------------------

// Registers (or re-confirms) a browser/device's FCM token for a user.
// Tokens are globally unique in FCM, so if the same token was previously
// tied to a different account (e.g. someone logged out and a different
// person logged into the same browser), it is reassigned rather than
// duplicated.
export const registerDevice = async ({ userId, token, deviceInfo }) => {
  const cleanDeviceInfo = deviceInfo
    ? String(deviceInfo).slice(0, MAX_DEVICE_INFO_LENGTH)
    : null;

  const registration = await prisma.pushRegistration.upsert({
    where: { token },
    update: { userId, deviceInfo: cleanDeviceInfo, active: true, lastUsedAt: new Date() },
    create: { token, userId, deviceInfo: cleanDeviceInfo, active: true },
  });

  return registration;
};

// Removes a single device's registration. Scoped to userId so a user can
// only ever unregister their own device, never someone else's.
export const unregisterDevice = async ({ userId, token }) => {
  const result = await prisma.pushRegistration.deleteMany({ where: { userId, token } });
  return result.count > 0;
};

// Summary used by the Settings → Notifications UI to show whether *this*
// account has any active push registrations at all (across all devices).
export const getPushStatus = async (userId) => {
  const activeCount = await prisma.pushRegistration.count({ where: { userId, active: true } });
  return { activeDeviceCount: activeCount, hasActiveDevice: activeCount > 0 };
};

// --- Sending -------------------------------------------------------------

// Deactivates a token FCM has reported as no longer valid, instead of
// deleting it outright — see the `active` field's doc comment in
// schema.prisma for why.
const deactivateToken = async (token) => {
  await prisma.pushRegistration.updateMany({ where: { token }, data: { active: false } }).catch(() => {});
};

const isUnregisteredError = (error) => {
  const code = error?.code || "";
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token" ||
    code === "messaging/invalid-argument"
  );
};

// Sends a push notification for a single already-created in-app
// Notification row to every active device registered to its recipient,
// provided the recipient hasn't turned off that category of push in
// Settings. Called from circleRealtime.js right after a Notification is
// created — nothing else in the codebase should call firebase-admin
// directly.
//
// Deliberately never throws: a Firebase outage or misconfiguration must
// never break the chat/notification flow that triggered it. Callers should
// invoke this without awaiting (fire-and-forget) for that same reason.
export const sendPushForNotification = async (notification) => {
  try {
    const messaging = getMessaging();
    if (!messaging) return; // Firebase not configured — silently skip.

    const config = configFor(notification.type);
    if (!config) return; // Unmapped notification type: no push category to check.

    const user = await prisma.user.findUnique({
      where: { id: notification.userId },
      select: { [config.category]: true },
    });
    if (!user || user[config.category] === false) return; // Category disabled.

    const registrations = await prisma.pushRegistration.findMany({
      where: { userId: notification.userId, active: true },
      select: { token: true },
    });
    if (registrations.length === 0) {
      console.warn(`[pushNotificationService] No active FCM registration for user ${notification.userId}.`);
      return;
    }

    const destinationUrl = config.urlFor(notification);

    // Use a data-only message for Web Push. This gives our Firebase
    // service worker full control over the notification, avoiding the
    // duplicate-notification behaviour that can occur when an FCM
    // notification payload and onBackgroundMessage both display one.
    const message = {
      data: {
        notificationId: String(notification.id),
        type: notification.type,
        title: String(notification.title || "Study2Gate"),
        body: String(notification.body || ""),
        circleId: notification.circleId ? String(notification.circleId) : "",
        url: destinationUrl,
      },
      webpush: {
        headers: { Urgency: "high" },
      },
      tokens: registrations.map((r) => r.token),
    };

    const response = await messaging.sendEachForMulticast(message);
    console.log(`[pushNotificationService] Sent ${notification.type} notification ${notification.id}: ${response.successCount} succeeded, ${response.failureCount} failed.`);

    if (response.failureCount > 0) {
      await Promise.all(
        response.responses.map((result, index) => {
          if (!result.success && isUnregisteredError(result.error)) {
            return deactivateToken(registrations[index].token);
          }
          return Promise.resolve();
        })
      );
    }

    const successTokens = registrations
      .filter((_, index) => response.responses[index]?.success)
      .map((r) => r.token);
    if (successTokens.length > 0) {
      await prisma.pushRegistration.updateMany({
        where: { token: { in: successTokens } },
        data: { lastUsedAt: new Date() },
      });
    }
  } catch (error) {
    console.error("[pushNotificationService] Failed to send push notification:", error.message);
  }
};
