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

// Uploaded-material management.
router.get("/files", getAdminFiles);
router.delete("/files/:id", deleteAdminFile);

export default router;
