import express from "express";
import { protect } from "../middleware/auth.js";
import { getActiveAnnouncements, dismissAnnouncement } from "../controllers/announcementsController.js";

// User-facing half of admin announcements. The admin half (create, list,
// retire, delete) lives in routes/admin.js behind protect + admin.
const router = express.Router();

router.get("/active", protect, getActiveAnnouncements);
router.post("/:id/dismiss", protect, dismissAnnouncement);

export default router;
