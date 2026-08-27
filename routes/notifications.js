import express from "express";
import { protect } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { listNotifications, markNotificationRead, markAllNotificationsRead } from "../controllers/notificationsController.js";
import { registerPush, unregisterPush, getPushStatusHandler } from "../controllers/pushNotificationsController.js";

// A device only ever (re-)registers on login or when the user flips the
// Settings toggle, so this is generous while still blocking abuse.
const pushRegisterLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyPrefix: "push-register",
  message: "Too many push registration attempts. Please try again later.",
});

const router = express.Router();
router.get("/", protect, listNotifications);
router.patch("/:id/read", protect, markNotificationRead);
router.patch("/read-all", protect, markAllNotificationsRead);

router.post("/register", protect, pushRegisterLimiter.middleware, registerPush);
router.delete("/unregister", protect, unregisterPush);
router.get("/status", protect, getPushStatusHandler);

export default router;
