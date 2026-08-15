import express from "express";
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

export default router;
