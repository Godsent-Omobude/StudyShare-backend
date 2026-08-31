import express from "express";
import crypto from "crypto";
import sendPasswordResetEmail, { sendVerificationEmail } from "../services/email.js";
import bcrypt from "bcryptjs";
import prisma from "../config/prisma.js";
import { validatePassword } from "../utils/passwordPolicy.js";
import { createAuthToken, createPolicyPendingToken, verifyPolicyPendingToken } from "../utils/token.js";
import { setAuthCookie, clearAuthCookie, getAuthCookie } from "../utils/cookies.js";
import {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  verifyEmailLimiter,
  resendVerificationLimiter,
} from "../middleware/rateLimiter.js";
import { protect, verifyAccessToken } from "../middleware/auth.js";
import { CURRENT_COPYRIGHT_POLICY_VERSION, hasAcceptedCurrentCopyrightPolicy } from "../utils/legalPolicy.js";

const router = express.Router();

const normalizeUsername = (value) => String(value || "").trim().toLowerCase();
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// 15 minutes to enter the code before it expires and a fresh one is needed.
const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;

const generateVerificationCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const hashVerificationCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

// Generates a fresh code, stores its hash + expiry on the user, resets the
// per-user attempt counter, and emails it. Shared by register + resend.
//
// The DB write is awaited (the code must be persisted before we tell the
// caller a code was issued), but the actual email delivery is fired off
// without awaiting it: it's an HTTP call to a third-party provider (Brevo)
// and has no bearing on whether this request should complete — the code is
// already valid and waiting once it's in the database. Awaiting it here
// previously meant register/resend requests sat on hold for however long
// Brevo took to answer. Failures are still logged so delivery problems
// aren't silently swallowed.
const issueVerificationCode = async (user) => {
  const code = generateVerificationCode();

  await prisma.user.update({
    where: { id: user.id },
    data: {
      verificationCodeHash: hashVerificationCode(code),
      verificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      verificationAttempts: 0,
      verificationCodeSentAt: new Date(),
    },
  });

  sendVerificationEmail({ to: user.email, code }).catch((error) => {
    console.error("Verification email failed to send:", error);
  });
};

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
  copyrightPolicyAccepted: hasAcceptedCurrentCopyrightPolicy(user),
});

const createToken = (user) => createAuthToken(user);

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

router.post("/register", registerLimiter.middleware, async (req, res) => {
  const { fullName, username, email, matricNumber, password, copyrightPolicyAccepted } = req.body;
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

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ message: passwordCheck.message });
    }

    if (copyrightPolicyAccepted !== true) {
      return res.status(400).json({
        message: "You must accept the Copyright Policy to create an account.",
      });
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
        copyrightPolicyAcceptedAt: new Date(),
        copyrightPolicyVersion: CURRENT_COPYRIGHT_POLICY_VERSION,
      },
    });

    // Accounts start unverified — no auth cookie is issued here. The user
    // must enter the emailed code (see /verify-email) before they can log
    // in at all.
    await issueVerificationCode(user);

    return res.status(201).json({
      verificationRequired: true,
      email: user.email,
      message: "Account created. Enter the 6-digit code we emailed you to verify your account.",
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

router.post("/login", loginLimiter.middleware, async (req, res) => {
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
      loginLimiter.recordAttempt(req);
      return res.status(400).json({ message: "Invalid username or password." });
    }

    loginLimiter.reset(req);

    if (!user.emailVerified) {
      return res.status(403).json({
        verificationRequired: true,
        email: user.email,
        message: "Please verify your email address before logging in.",
      });
    }

    // Mandatory Copyright Policy gate: credentials are valid, but no auth
    // cookie is issued until the current policy version is accepted. The
    // pendingToken can only be redeemed at /auth/accept-copyright-policy —
    // it carries no session privileges of its own.
    if (!hasAcceptedCurrentCopyrightPolicy(user)) {
      return res.status(403).json({
        copyrightPolicyAcceptanceRequired: true,
        pendingToken: createPolicyPendingToken(user),
        message: "Please review and accept the Copyright Policy to continue.",
      });
    }

    setAuthCookie(res, createToken(user));

    return res.json(publicUser(user));
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Authentication system failure." });
  }
});

// Redeems either a pendingToken (issued by /auth/login when acceptance was
// the only thing blocking login) or an existing valid auth cookie (for a
// user who was already signed in when the policy version changed). Either
// way: record acceptance of the current policy version, then issue/refresh
// the real auth cookie.
router.post("/accept-copyright-policy", loginLimiter.middleware, async (req, res) => {
  const { pendingToken } = req.body;

  try {
    let userId;

    if (pendingToken) {
      const decoded = verifyPolicyPendingToken(pendingToken);
      userId = decoded.id;
    } else {
      const cookieToken = getAuthCookie(req);
      if (!cookieToken) {
        return res.status(401).json({ message: "Not authorised. No token provided." });
      }
      const decoded = verifyAccessToken(cookieToken);
      userId = decoded.id;
    }

    const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
    if (!user) {
      return res.status(401).json({ message: "User not found." });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        copyrightPolicyAcceptedAt: new Date(),
        copyrightPolicyVersion: CURRENT_COPYRIGHT_POLICY_VERSION,
      },
    });

    loginLimiter.reset(req);
    setAuthCookie(res, createToken(updatedUser));

    return res.json(publicUser(updatedUser));
  } catch (error) {
    loginLimiter.recordAttempt(req);
    return res.status(401).json({ message: "This request has expired. Please log in again." });
  }
});


router.post("/forgot-password", forgotPasswordLimiter.middleware, async (req, res) => {
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

    // Fired off rather than awaited — see issueVerificationCode above for
    // why: the reset token is already persisted, so this request shouldn't
    // sit on hold for Brevo's response time.
    sendPasswordResetEmail({ to: user.email, resetUrl }).catch((error) => {
      console.error("Password reset email failed to send:", error);
    });

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

  const passwordCheck = validatePassword(newPassword);
  if (!passwordCheck.valid) {
    return res.status(400).json({ message: passwordCheck.message });
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
        // Invalidate any existing session tokens (e.g. a stolen token) —
        // this is exactly the situation a password reset is meant to
        // recover from.
        tokenVersion: { increment: 1 },
      },
    });

    return res.json({ message: "Password reset successfully. You can now log in." });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ message: "Unable to reset password." });
  }
});

router.post("/verify-email", verifyEmailLimiter.middleware, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || "").trim();

  if (!email || !code) {
    return res.status(400).json({ message: "Email and verification code are required." });
  }

  try {
    const user = await prisma.user.findFirst({ where: { email } });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired verification code." });
    }

    if (user.emailVerified) {
      setAuthCookie(res, createToken(user));
      return res.json(publicUser(user));
    }

    if (
      !user.verificationCodeHash ||
      !user.verificationCodeExpiresAt ||
      user.verificationCodeExpiresAt < new Date() ||
      user.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS
    ) {
      verifyEmailLimiter.recordAttempt(req);
      return res.status(400).json({
        message: "This verification code has expired. Please request a new one.",
      });
    }

    if (hashVerificationCode(code) !== user.verificationCodeHash) {
      verifyEmailLimiter.recordAttempt(req);
      await prisma.user.update({
        where: { id: user.id },
        data: { verificationAttempts: { increment: 1 } },
      });
      return res.status(400).json({ message: "Invalid or expired verification code." });
    }

    verifyEmailLimiter.reset(req);

    const verifiedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationCodeHash: null,
        verificationCodeExpiresAt: null,
        verificationAttempts: 0,
        verificationCodeSentAt: null,
      },
    });

    setAuthCookie(res, createToken(verifiedUser));
    return res.json(publicUser(verifiedUser));
  } catch (error) {
    console.error("Email verification error:", error);
    return res.status(500).json({ message: "Unable to verify email address." });
  }
});

router.post("/resend-verification", resendVerificationLimiter.middleware, async (req, res) => {
  const email = normalizeEmail(req.body.email);

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }

  // Same generic response whether or not the account exists / is already
  // verified, so this endpoint can't be used to probe registered emails.
  const genericMessage = "If that account needs verification, a new code has been sent.";

  try {
    const user = await prisma.user.findFirst({ where: { email } });

    if (!user || user.emailVerified) {
      return res.json({ message: genericMessage });
    }

    await issueVerificationCode(user);

    return res.json({ message: genericMessage });
  } catch (error) {
    console.error("Resend verification error:", error);
    return res.status(500).json({ message: "Unable to resend verification code." });
  }
});

// Lets the frontend ask "am I logged in, and as whom" without being able to
// read the (now httpOnly) auth cookie itself.
router.get("/me", protect, (req, res) => {
  return res.json(publicUser(req.user));
});

router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  return res.json({ message: "Logged out." });
});

export default router;
