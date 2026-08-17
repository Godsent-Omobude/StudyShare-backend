import express from "express";
import crypto from "crypto";
import sendPasswordResetEmail from "../services/email.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma.js";

const router = express.Router();

const normalizeUsername = (value) => String(value || "").trim().toLowerCase();

const publicUser = (user) => ({
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

const createToken = (user) =>
  jwt.sign(
    { id: user.id, fullName: user.fullName, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

router.get("/check-username/:username", async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);

    if (!username || username.length < 3) {
      return res.json({ available: false, message: "Username must be at least 3 characters." });
    }

    const existing = await prisma.user.findFirst({
      where: { username },
      select: { id: true },
    });

    return res.json({ available: !existing });
  } catch (error) {
    return res.status(500).json({ message: "Unable to check username availability." });
  }
});

router.post("/register", async (req, res) => {
  const { fullName, username, email, matricNumber, password } = req.body;
  const normalizedUsername = normalizeUsername(username);
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedMatric = String(matricNumber || "").trim() || null;

  try {
    if (!fullName?.trim()) {
      return res.status(400).json({ message: "Full name is required." });
    }

    if (!normalizedEmail) {
      return res.status(400).json({ message: "Email address is required." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ message: "Enter a valid email address." });
    }

    if (!normalizedUsername || !/^[a-zA-Z0-9._-]{3,30}$/.test(normalizedUsername)) {
      return res.status(400).json({
        message: "Username must be 3–30 characters and may contain letters, numbers, dots, underscores or hyphens.",
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    const [usernameExists, emailExists] = await Promise.all([
      prisma.user.findFirst({
        where: { username: normalizedUsername },
        select: { id: true },
      }),
      prisma.user.findFirst({
        where: { email: normalizedEmail },
        select: { id: true },
      }),
    ]);

    if (usernameExists) {
      return res.status(409).json({ message: "Username is already taken." });
    }

    if (emailExists) {
      return res.status(409).json({ message: "Email address is already registered." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        fullName: fullName.trim(),
        username: normalizedUsername,
        email: normalizedEmail,
        matricNumber: normalizedMatric,
        password: hashedPassword,
      },
    });

    const token = createToken(user);

    return res.status(201).json({
      token,
      ...publicUser(user),
    });
  } catch (error) {
    if (error?.code === "P2002") {
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(", ") : "";
      return res.status(409).json({
        message: target.includes("email")
          ? "Email address is already registered."
          : "Username is already taken.",
      });
    }

    console.error("Registration error:", error);
    return res.status(500).json({ message: "Registration failed." });
  }
});

router.post("/login", async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const { password } = req.body;

  try {
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required." });
    }

    const user = await prisma.user.findFirst({
      where: { username },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ message: "Invalid username or password." });
    }

    return res.json({
      token: createToken(user),
      ...publicUser(user),
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Authentication system failure." });
  }
});


router.post("/forgot-password", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }

  try {
    const user = await prisma.user.findFirst({ where: { email } });

    // Always return the same message so the endpoint cannot be used to
    // discover whether an email address is registered.
    const genericMessage = "If an account with that email exists, a password reset link has been sent.";

    if (!user) {
      return res.json({ message: genericMessage });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordTokenHash: tokenHash,
        resetPasswordExpiresAt: expiresAt,
      },
    });

    const frontendUrl = String(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
    const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;

    await sendPasswordResetEmail({ to: user.email, resetUrl });

    return res.json({ message: genericMessage });
  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ message: "Unable to process password reset request." });
  }
});

router.post("/reset-password", async (req, res) => {
  const token = String(req.body.token || "").trim();
  const newPassword = String(req.body.password || "");

  if (!token) {
    return res.status(400).json({ message: "Reset token is required." });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters." });
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const user = await prisma.user.findFirst({
      where: {
        resetPasswordTokenHash: tokenHash,
        resetPasswordExpiresAt: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({
        message: "This password reset link is invalid or has expired.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetPasswordTokenHash: null,
        resetPasswordExpiresAt: null,
      },
    });

    return res.json({ message: "Password reset successfully. You can now log in." });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ message: "Unable to reset password." });
  }
});

export default router;
