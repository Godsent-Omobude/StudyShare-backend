import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import prisma from "../config/prisma.js";
import { protect } from "../middleware/auth.js";
import { uploadToB2, deleteFromB2 } from "../services/b2Storage.js";
import { validatePassword } from "../utils/passwordPolicy.js";
import { createAuthToken } from "../utils/token.js";
import { setAuthCookie } from "../utils/cookies.js";

const router = express.Router();
const profileUploadDir = "uploads/profile";

// Profile pictures are only ever shown as small circles, so everything is
// stored as a 256x256 WebP (a few KB to ~25 KB) instead of the original
// photo (up to 5 MB). .rotate() applies the phone's EXIF orientation, and
// sharp drops metadata such as GPS location.
const AVATAR_SIZE = 256;

// Pictures uploaded before resizing existed are shrunk the first time they
// are requested, if they are bigger than this.
const AVATAR_MIGRATE_ABOVE_BYTES = 150 * 1024;

// A year. Safe because a picture's object key is a fresh UUID for every
// upload — the content behind a given key never changes — and the frontend
// puts that key in the request URL (?v=...), so a new upload is a new URL.
const AVATAR_CACHE_CONTROL = "private, max-age=31536000, immutable";

const toAvatarBuffer = (input) =>
  sharp(input)
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
    .webp({ quality: 80 })
    .toBuffer();

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// Users whose old picture is being shrunk right now, so two requests at
// once can't both do it.
const migratingAvatars = new Set();

// Shrinks an old, oversized picture into a new WebP object and points the
// user at it. Returns the small buffer, or null if anything went wrong or
// the picture changed in the meantime (the caller then serves the original).
const migrateOldAvatar = async (userId, oldKey, originalBuffer) => {
  if (migratingAvatars.has(userId)) return null;
  migratingAvatars.add(userId);

  const tempPath = `${profileUploadDir}/${Date.now()}-${randomUUID()}.avatar.webp`;
  const newKey = `profile-pictures/${userId}/${randomUUID()}.webp`;
  let uploaded = false;

  try {
    const small = await toAvatarBuffer(originalBuffer);
    await fs.promises.writeFile(tempPath, small);
    await uploadToB2({ filePath: tempPath, objectKey: newKey, contentType: "image/webp" });
    uploaded = true;

    // Only switch if the user still has the picture we just shrank — never
    // overwrite a newer upload made while this was running.
    const { count } = await prisma.user.updateMany({
      where: { id: userId, profilePicture: oldKey },
      data: { profilePicture: newKey },
    });

    if (count === 0) {
      await deleteFromB2(newKey).catch(() => {});
      return null;
    }

    await deleteFromB2(oldKey).catch((error) =>
      console.error("Old profile picture cleanup error:", error)
    );

    return small;
  } catch (error) {
    console.error("Profile picture shrink error:", error);
    if (uploaded) await deleteFromB2(newKey).catch(() => {});
    return null;
  } finally {
    migratingAvatars.delete(userId);
    await fs.promises.unlink(tempPath).catch(() => {});
  }
};

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

    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      // Previously `cb(null, false)` — that silently drops the file
      // instead of erroring, so a wrong-type upload and a genuinely
      // empty submission were indistinguishable by the time the route
      // handler's `if (!req.file)` check ran; both produced the same
      // "choose a JPG/PNG/WEBP" message even for someone who *did*
      // choose a file, just the wrong kind. Erroring here instead lets
      // the message below be specific to what actually happened.
      cb(new Error("That file type isn't supported. Please choose a JPG, PNG or WEBP image."));
    }
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
  // Read-only account standing — surfaced in Settings → Account standing
  // so a warning or suspension is visible before it escalates, instead of
  // only appearing as a hard block from protect() (see middleware/auth.js).
  copyrightWarnings: true,
  suspendedUntil: true,
  suspendedReason: true,
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
  copyrightWarnings: user.copyrightWarnings,
  suspendedUntil: user.suspendedUntil,
  suspendedReason: user.suspendedReason,
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

    res.setHeader("Cache-Control", AVATAR_CACHE_CONTROL);

    // Old, oversized picture: shrink it once, for everyone from now on.
    // If that fails for any reason, the original is still served as before.
    if (b2File.ContentLength !== undefined && b2File.ContentLength > AVATAR_MIGRATE_ABOVE_BYTES) {
      const original = await streamToBuffer(b2File.Body);
      const small = await migrateOldAvatar(req.user.id, user.profilePicture, original);

      const body = small || original;
      res.setHeader("Content-Type", small ? "image/webp" : b2File.ContentType || "image/jpeg");
      res.setHeader("Content-Length", body.length);
      return res.end(body);
    }

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
  // "blue" is the stored id of the default teal accent; "royalblue" is the real blue.
  const allowedAccents = ["blue", "royalblue", "red", "purple", "green", "yellow"];
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
    return res.status(400).json({ message: "Please choose an image to upload." });
  }

  let newObjectKey = null;
  const processedPath = `${req.file.path}.avatar.webp`;

  const cleanupTempFiles = async () => {
    await fs.promises.unlink(req.file.path).catch(() => {});
    await fs.promises.unlink(processedPath).catch(() => {});
  };

  // Shrink first. A file that only has an image extension but isn't a real
  // image fails here with a clear message instead of a vague 500 later.
  let avatar;
  try {
    avatar = await toAvatarBuffer(req.file.path);
  } catch (imageError) {
    console.error("Profile picture processing error:", imageError);
    await cleanupTempFiles();
    return res.status(400).json({
      message: "We couldn't read that image. Please choose a different photo.",
    });
  }

  try {
    await fs.promises.writeFile(processedPath, avatar);

    newObjectKey = `profile-pictures/${req.user.id}/${randomUUID()}.webp`;

    await uploadToB2({
      filePath: processedPath,
      objectKey: newObjectKey,
      contentType: "image/webp",
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

    await cleanupTempFiles();

    if (oldUser?.profilePicture) {
      await deleteFromB2(oldUser.profilePicture).catch((error) =>
        console.error("Old profile picture cleanup error:", error)
      );
    }

    res.json(cleanUser(user));
  } catch (error) {
    await cleanupTempFiles();
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

    // Fingerprint login is tied to the old credentials' trust, so it has
    // to be switched on again with the new password.
    await prisma.biometricDevice.deleteMany({ where: { userId: req.user.id } });

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
