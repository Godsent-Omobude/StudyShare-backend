// Reusable push-notification sending logic, kept separate from the
// controllers/routes that trigger it (see 20260825160000_add_push_notifications
// migration and circleRealtime.js for where this gets called from).
//
// Nothing outside this file talks to firebase-admin directly — controllers
// and other services only ever call the functions exported here.

import prisma from "../config/prisma.js";
import { getMessaging } from "../config/firebaseAdmin.js";

const MAX_DEVICE_INFO_LENGTH = 200;

// Notification channel used by the native Android app (created in
// frontend/src/firebase/messaging.js — the two ids must match). High
// importance, so streak warnings and messages make a sound and pop up.
const ANDROID_CHANNEL_ID = "study2gate_alerts";

// Push for these types shows generic wording instead of the real text,
// since the native app keeps receiving pushes after sign-out and a locked
// phone's screen can be read by anyone. The full text is still visible
// in-app (notification bell) once signed in.
const GENERIC_PUSH_TYPES = new Set(["ACCOUNT_SECURITY", "COPYRIGHT"]);
const GENERIC_PUSH_TEXT = {
  title: "Study2Gate",
  body: "You have a new alert. Open Study2Gate to view it.",
};

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
  // ttlMs: how long FCM should keep trying to deliver if the phone is
  // offline. A "study now to keep your streak" warning is useless hours
  // later, so it expires instead of arriving stale.
  STREAK_AT_RISK: {
    category: "notifyFlashcardActivity",
    urlFor: () => "/",
    ttlMs: 3 * 60 * 60 * 1000,
  },
  STREAK_BROKEN: {
    category: "notifyFlashcardActivity",
    urlFor: () => "/",
    ttlMs: 12 * 60 * 60 * 1000,
  },
  ACCOUNT_SECURITY: {
    category: "notifyAccountSecurity",
    urlFor: () => "/settings",
  },
  ANNOUNCEMENT: {
    category: "notifyAnnouncements",
    urlFor: () => "/dashboard",
  },
  COPYRIGHT: {
    category: "notifyAccountSecurity",
    urlFor: () => "/materials",
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

// Full device list for Settings → Manage devices. Includes the raw token
// (not just an id) so the client can tell which row is the device it's
// currently on by comparing against its own local FCM token — this never
// leaves the response to anyone but the device's own owner, since every
// route here is scoped to req.user.id.
export const listDevices = async (userId) => {
  return prisma.pushRegistration.findMany({
    where: { userId },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, token: true, deviceInfo: true, createdAt: true, lastUsedAt: true, active: true },
  });
};

// Revokes one device by its registration id rather than its token, so
// Settings → Manage devices can let someone remove a *different* device
// (e.g. a lost phone) without that device's token ever having to be typed
// or passed around client-side. Scoped to userId so a user can only ever
// remove their own registrations.
export const unregisterDeviceById = async ({ userId, id }) => {
  const result = await prisma.pushRegistration.deleteMany({ where: { userId, id: Number(id) } });
  return result.count > 0;
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
    if (registrations.length === 0) return;

    const destinationUrl = config.urlFor(notification);

    const isGeneric = GENERIC_PUSH_TYPES.has(notification.type);

    const message = {
      notification: {
        title: isGeneric ? GENERIC_PUSH_TEXT.title : notification.title,
        body: isGeneric ? GENERIC_PUSH_TEXT.body : notification.body,
      },
      data: {
        notificationId: String(notification.id),
        type: notification.type,
        circleId: notification.circleId ? String(notification.circleId) : "",
        url: destinationUrl,
      },
      // Native Android app. High priority so FCM delivers immediately
      // even while the phone is idle (Doze) — needed for time-sensitive
      // alerts like streak warnings. Ignored by web (webpush) tokens.
      android: {
        priority: "high",
        ...(config.ttlMs ? { ttl: config.ttlMs } : {}),
        notification: { channelId: ANDROID_CHANNEL_ID },
      },
      webpush: {
        fcmOptions: { link: destinationUrl },
      },
      tokens: registrations.map((r) => r.token),
    };

    const response = await messaging.sendEachForMulticast(message);

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
