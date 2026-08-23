import express from "express";
import { protect } from "../middleware/auth.js";
import { listNotifications, markNotificationRead, markAllNotificationsRead } from "../controllers/notificationsController.js";

const router = express.Router();
router.get("/", protect, listNotifications);
router.patch("/:id/read", protect, markNotificationRead);
router.patch("/read-all", protect, markAllNotificationsRead);
export default router;
