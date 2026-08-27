// Initializes the Firebase Admin SDK, used only on the backend to send
// push notifications via Firebase Cloud Messaging (FCM). This module never
// runs in the frontend — the private key below must never be exposed to
// the browser.
//
// Required environment variables (see .env.example):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (the full PEM key; \n escaped if set via a
//                           single-line env var, e.g. in Render's dashboard)
//
// If these are not configured, initialization is skipped rather than
// crashing the server — pushNotificationService then no-ops with a clear
// warning instead of taking down the rest of Study2Gate. This matters
// because push notifications are an additive feature: an unconfigured or
// misconfigured Firebase project must never block chat, auth, or anything
// else that already works.

import admin from "firebase-admin";

let messagingInstance = null;
let initAttempted = false;

const initFirebaseAdmin = () => {
  if (initAttempted) return messagingInstance;
  initAttempted = true;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    console.warn(
      "[firebaseAdmin] Push notifications are disabled: FIREBASE_PROJECT_ID, " +
      "FIREBASE_CLIENT_EMAIL, and/or FIREBASE_PRIVATE_KEY are not set. " +
      "See .env.example for setup instructions."
    );
    return null;
  }

  try {
    // Env vars are usually stored as a single line, so literal "\n"
    // sequences need to be converted back into real newlines for the PEM
    // key to parse correctly.
    const privateKey = rawPrivateKey.includes("\\n")
      ? rawPrivateKey.replace(/\\n/g, "\n")
      : rawPrivateKey;

    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        });

    messagingInstance = admin.messaging(app);
    console.log("[firebaseAdmin] Firebase Admin SDK initialized.");
  } catch (error) {
    console.error("[firebaseAdmin] Failed to initialize Firebase Admin SDK:", error.message);
    messagingInstance = null;
  }

  return messagingInstance;
};

// Lazily initialized so a missing/invalid config doesn't throw at server
// startup — only when a push is actually attempted.
export const getMessaging = () => messagingInstance || initFirebaseAdmin();

export const isFirebaseConfigured = () => Boolean(getMessaging());
