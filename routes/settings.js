import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import prisma from "../config/prisma.js";
import { protect } from "../middleware/auth.js";
import { uploadToB2, deleteFromB2 } from "../services/b2Storage.js";
import { validatePassword } from "../utils/passwordPolicy.js";
import { createAuthToken } from "../utils/token.js";
import { setAuthCookie } from "../utils/cookies.js";

const router = express.Router();
const profileUploadDir = "uploads/profile";

if (!fs.existsSync(profileUploadDir)) {
  fs.mkdirSync(profileUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, profileUploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${randomUUID()}${ext}`);
  },
});

const profileUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

const selectSettingsUser = {
  id: true,
  fullName: true,
  username: true,
  email: true,
  matricNumber: true,
  role: true,
  profilePicture: true,
  showUsernameOnMaterials: true,
  theme: true,
  accentColor: true,
};

const cleanUser = (user) => ({
  id: user.id,
  fullName: user.fullName,
  username: user.username,
  email: user.email,
  matricNumber: user.matricNumber,
  role: user.role,
  profilePicture: user.profilePicture,
  showUsernameOnMaterials: user.showUsernameOnMaterials,
  theme: user.theme,
  accentColor: user.accentColor,
});


router.get("/profile-picture", protect, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { profilePicture: true },
    });

    if (!user?.profilePicture) {
      return res.status(404).end();
    }

    const { getFromB2 } = await import("../services/b2Storage.js");
    const b2File = await getFromB2(user.profilePicture);

    res.setHeader("Content-Type", b2File.ContentType || "image/jpeg");
    if (b2File.ContentLength !== undefined) {
      res.setHeader("Content-Length", b2File.ContentLength);
    }

    b2File.Body.pipe(res);
  } catch (error) {
    console.error("Profile picture fetch error:", error);
    res.status(404).end();
  }
});

router.get("/", protect, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: selectSettingsUser,
    });

    if (!user) return res.status(404).json({ message: "User not found." });

    res.json(cleanUser(user));
  } catch (error) {
    console.error("Get settings error:", error);
    res.status(500).json({ message: "Unable to load settings." });
  }
});

router.patch("/profile", protect, async (req, res) => {
  const { fullName, matricNumber } = req.body;

  try {
    if (!fullName?.trim()) {
      return res.status(400).json({ message: "Full name is required." });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        fullName: fullName.trim(),
        matricNumber: String(matricNumber || "").trim() || null,
      },
      select: selectSettingsUser,
    });

    res.json(cleanUser(user));
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ message: "Unable to update profile." });
  }
});

router.patch("/appearance", protect, async (req, res) => {
  const allowedThemes = ["light", "dark", "system"];
  const allowedAccents = ["blue", "red", "purple", "green", "yellow"];
  const { theme, accentColor } = req.body;

  if (theme !== undefined && !allowedThemes.includes(theme)) {
    return res.status(400).json({ message: "Invalid theme." });
  }

  if (accentColor !== undefined && !allowedAccents.includes(accentColor)) {
    return res.status(400).json({ message: "Invalid accent colour." });
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(theme !== undefined ? { theme } : {}),
        ...(accentColor !== undefined ? { accentColor } : {}),
      },
      select: selectSettingsUser,
    });

    res.json(cleanUser(user));
  } catch (error) {
    console.error("Appearance update error:", error);
    res.status(500).json({ message: "Unable to save appearance settings." });
  }
});

router.patch("/privacy", protect, async (req, res) => {
  if (typeof req.body.showUsernameOnMaterials !== "boolean") {
    return res.status(400).json({ message: "showUsernameOnMaterials must be true or false." });
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { showUsernameOnMaterials: req.body.showUsernameOnMaterials },
      select: selectSettingsUser,
    });

    res.json(cleanUser(user));
  } catch (error) {
    console.error("Privacy update error:", error);
    res.status(500).json({ message: "Unable to save privacy setting." });
  }
});

const selectNotificationPrefs = {
  notifyCircleMessages: true,
  notifyCircleInvitations: true,
  notifyMentions: true,
  notifyCircleActivity: true,
  notifyFlashcardActivity: true,
  notifyAccountSecurity: true,
  notifyAnnouncements: true,
};

router.get("/notifications", protect, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: selectNotificationPrefs,
    });

    if (!user) return res.status(404).json({ message: "User not found." });

    res.json(user);
  } catch (error) {
    console.error("Get notification preferences error:", error);
    res.status(500).json({ message: "Unable to load notification preferences." });
  }
});

router.patch("/notifications", protect, async (req, res) => {
  const allowedKeys = Object.keys(selectNotificationPrefs);
  const data = {};

  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) {
      if (typeof req.body[key] !== "boolean") {
        return res.status(400).json({ message: `${key} must be true or false.` });
      }
      data[key] = req.body[key];
    }
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: "No valid notification preferences supplied." });
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: selectNotificationPrefs,
    });

    res.json(user);
  } catch (error) {
    console.error("Update notification preferences error:", error);
    res.status(500).json({ message: "Unable to save notification preferences." });
  }
});

router.post("/profile-picture", protect, profileUpload.single("profilePicture"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Please choose a JPG, PNG or WEBP image up to 5 MB." });
  }

  let newObjectKey = null;

  try {
    newObjectKey = `profile-pictures/${req.user.id}/${randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`;

    await uploadToB2({
      filePath: req.file.path,
      objectKey: newObjectKey,
      contentType: req.file.mimetype,
    });

    const oldUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { profilePicture: true },
    });

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { profilePicture: newObjectKey },
      select: selectSettingsUser,
    });

    await fs.promises.unlink(req.file.path).catch(() => {});

    if (oldUser?.profilePicture) {
      await deleteFromB2(oldUser.profilePicture).catch((error) =>
        console.error("Old profile picture cleanup error:", error)
      );
    }

    res.json(cleanUser(user));
  } catch (error) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    if (newObjectKey) await deleteFromB2(newObjectKey).catch(() => {});

    console.error("Profile picture upload error:", error);
    res.status(500).json({ message: "Unable to update profile picture." });
  }
});

router.delete("/profile-picture", protect, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { profilePicture: true },
    });

    if (user?.profilePicture) {
      await deleteFromB2(user.profilePicture);
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { profilePicture: null },
      select: selectSettingsUser,
    });

    res.json(cleanUser(updated));
  } catch (error) {
    console.error("Remove profile picture error:", error);
    res.status(500).json({ message: "Unable to remove profile picture." });
  }
});

router.patch("/password", protect, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: "Current and new passwords are required." });
  }

  const passwordCheck = validatePassword(newPassword);
  if (!passwordCheck.valid) {
    return res.status(400).json({ message: passwordCheck.message });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { password: true },
    });

    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Bumping tokenVersion invalidates every other token issued for this
    // account (e.g. on another device, or one an attacker may have
    // obtained), so a new token is issued below to keep this session
    // logged in.
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: { password: hashedPassword, tokenVersion: { increment: 1 } },
    });

    setAuthCookie(res, createAuthToken(updatedUser));
    res.json({ message: "Password changed successfully." });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ message: "Unable to change password." });
  }
});

router.delete("/account", protect, async (req, res) => {
  const { confirmation, password } = req.body;

  if (confirmation !== "I agree to delete my account") {
    return res.status(400).json({
      message: 'Type exactly "I agree to delete my account" to confirm.',
    });
  }

  if (!password) {
    return res.status(400).json({ message: "Enter your password to confirm account deletion." });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { files: { select: { filepath: true } } },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ message: "Password is incorrect." });
    }

    const b2Objects = [
      ...user.files.map((file) => file.filepath).filter((key) => key && !key.startsWith("uploads/")),
      ...(user.profilePicture ? [user.profilePicture] : []),
    ];

    await Promise.allSettled(b2Objects.map((key) => deleteFromB2(key)));

    await prisma.user.delete({ where: { id: req.user.id } });

    res.json({ message: "Account deleted successfully." });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({ message: "Unable to delete account." });
  }
});

export default router;
