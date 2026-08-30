import express from "express";
import { protect } from "../middleware/auth.js";
import { copyrightReportLimiter, copyrightDisputeLimiter } from "../middleware/rateLimiter.js";
import {
  submitCopyrightReport,
  submitCopyrightDispute,
  getFileCopyrightStatus,
} from "../controllers/copyrightController.js";

const router = express.Router();

router.use(protect);

// Report a specific file as (potentially) infringing.
router.post("/files/:id/report", copyrightReportLimiter.middleware, submitCopyrightReport);

// Uploader's counter-notice against a RESTRICTED/REMOVED file.
router.post("/files/:id/dispute", copyrightDisputeLimiter.middleware, submitCopyrightDispute);

// Current status/reasoning for a single file (uploader or admin only).
router.get("/files/:id/status", getFileCopyrightStatus);

export default router;
