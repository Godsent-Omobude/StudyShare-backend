import { registerDevice, unregisterDevice, getPushStatus } from "../services/pushNotificationService.js";
import { isFirebaseConfigured } from "../config/firebaseAdmin.js";

const MAX_TOKEN_LENGTH = 4096;
const MAX_DEVICE_INFO_LENGTH = 200;

export const registerPush = async (req, res) => {
  try {
    const { token, deviceInfo } = req.body;

    if (typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ message: "A valid FCM registration token is required." });
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      return res.status(400).json({ message: "Invalid registration token." });
    }
    if (deviceInfo !== undefined && typeof deviceInfo !== "string") {
      return res.status(400).json({ message: "deviceInfo must be a string." });
    }
    if (typeof deviceInfo === "string" && deviceInfo.length > MAX_DEVICE_INFO_LENGTH) {
      return res.status(400).json({ message: "deviceInfo is too long." });
    }

    // req.user.id comes from the verified JWT (see middleware/auth.js) —
    // never from anything the client sends, so a user can never register a
    // device against another account.
    await registerDevice({ userId: req.user.id, token: token.trim(), deviceInfo });

    return res.status(201).json({ message: "Device registered for push notifications." });
  } catch (error) {
    console.error("Push register error:", error);
    return res.status(500).json({ message: "Unable to register device for push notifications." });
  }
};

export const unregisterPush = async (req, res) => {
  try {
    const { token } = req.body;

    if (typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ message: "A valid FCM registration token is required." });
    }

    await unregisterDevice({ userId: req.user.id, token: token.trim() });

    // Idempotent by design: whether or not a matching registration
    // existed, the end state the client wants (this token no longer
    // registered) now holds, so this always reports success.
    return res.json({ message: "Device unregistered from push notifications." });
  } catch (error) {
    console.error("Push unregister error:", error);
    return res.status(500).json({ message: "Unable to unregister device." });
  }
};

export const getPushStatusHandler = async (req, res) => {
  try {
    const status = await getPushStatus(req.user.id);
    return res.json({ ...status, firebaseConfigured: isFirebaseConfigured() });
  } catch (error) {
    console.error("Push status error:", error);
    return res.status(500).json({ message: "Unable to load push notification status." });
  }
};
