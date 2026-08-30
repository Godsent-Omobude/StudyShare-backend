import express from "express";
import { protect } from "../middleware/auth.js";
import { admin } from "../middleware/admin.js";
import {
  getAdminStats,
  getAdminUsers,
  updateUserRole,
  deleteUser,
  getAdminFiles,
  deleteAdminFile
} from "../controllers/adminController.js";
import {
  getCopyrightQueue,
  getCopyrightStats,
  getCopyrightFileDetail,
  getUploaderCopyrightHistory,
  performCopyrightFileAction,
  addCopyrightNote,
  performCopyrightUserAction,
  getCopyrightReports,
  createManualCopyrightCase,
  decideCopyrightReport,
  getCopyrightCaseRecord,
  getCopyrightDisputes,
  decideCopyrightDispute,
  getCopyrightAuditLog,
} from "../controllers/copyrightAdminController.js";

const router = express.Router();

// Every endpoint in this router requires a valid JWT AND role=admin.
router.use(protect, admin);

// Verify that the logged-in user has administrator privileges.
router.get("/check", (req, res) => {
  res.json({
    success: true,
    message: "Administrator access granted.",
    user: req.user
  });
});

// Dashboard overview.
router.get("/stats", getAdminStats);

// User management.
router.get("/users", getAdminUsers);
router.patch("/users/:id/role", updateUserRole);
router.delete("/users/:id", deleteUser);

// Uploaded-material management (legacy hard-delete tool — the copyright
// review queue below is the preferred, reversible path for anything
// copyright-related).
router.get("/files", getAdminFiles);
router.delete("/files/:id", deleteAdminFile);

// --- Copyright Review Queue ---------------------------------------------
router.get("/copyright/stats", getCopyrightStats);
router.get("/copyright/queue", getCopyrightQueue);
router.get("/copyright/files/:id", getCopyrightFileDetail);
router.post("/copyright/files/:id/actions", performCopyrightFileAction);
router.post("/copyright/files/:id/notes", addCopyrightNote);

router.get("/copyright/users/:id/history", getUploaderCopyrightHistory);
router.post("/copyright/users/:id/actions", performCopyrightUserAction);

router.get("/copyright/reports", getCopyrightReports);
router.post("/copyright/reports", createManualCopyrightCase);
router.patch("/copyright/reports/:id", decideCopyrightReport);
router.get("/copyright/reports/:id/record", getCopyrightCaseRecord);

router.get("/copyright/disputes", getCopyrightDisputes);
router.patch("/copyright/disputes/:id", decideCopyrightDispute);

router.get("/copyright/audit-log", getCopyrightAuditLog);

export default router;
