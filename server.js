import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs';
import multer from 'multer';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import aiRoutes from './routes/ai.js';
import adminRoutes from './routes/admin.js';
import settingsRoutes from './routes/settings.js';
import circleRoutes from './routes/circles.js';
import notificationRoutes from './routes/notifications.js';
import copyrightRoutes from './routes/copyright.js';
import { attachSocketServer } from './socket.js';
import { startStreakScheduler } from './services/streakScheduler.js';
import prisma from './config/prisma.js';

dotenv.config();

const app = express();
app.set("trust proxy", 1);

// Standard security headers (X-Content-Type-Options, X-Frame-Options,
// Strict-Transport-Security, a default Content-Security-Policy, etc).
// This is a pure JSON API (the frontend is a separately hosted SPA), so
// CSP's directives geared at HTML pages have little to bite on here, but
// the header is harmless to send and future-proofs against ever serving
// HTML (e.g. an error page) directly from this server.
app.use(helmet());

// Only allow the app's own frontend(s) to call this API with credentials.
// FRONTEND_URL may be a single URL or a comma-separated list (e.g. a
// production domain plus a Vercel preview URL). Requests with no Origin
// header (server-to-server calls, curl, Postman) are allowed through since
// they aren't subject to browser same-origin protections anyway.
const allowedOrigins = String(process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());

// Deliberately unauthenticated, DB-free, and mounted before any other
// route: this only answers "is the Node process alive and accepting
// requests," not "is Postgres also healthy" — a health check tied to a DB
// query would report the whole app down over a single flaky DB hiccup.
// Used by the frontend's status banner and by an external uptime monitor
// (e.g. UptimeRobot) polling from outside this infrastructure.
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads', { recursive: true });
}

if (!fs.existsSync('uploads/ai')) {
  fs.mkdirSync('uploads/ai', { recursive: true });
}

app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/circles', circleRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/copyright', copyrightRoutes);

// Centralized error handler. Errors thrown inside a route's own
// try/catch never reach this — they're already turned into a JSON
// response by that route. What lands here are errors raised by
// *middleware* before a route handler ever runs, most notably multer:
// a rejected file type (routes/files.js, middleware/upload.js,
// routes/settings.js all call `cb(new Error(...))` from their
// fileFilter) or an oversized file (multer's own `limits.fileSize`
// check, which throws a MulterError). Without a handler here, Express
// falls back to its default error page — an HTML response — which
// every frontend `error.response?.data?.message` read then silently
// fails to parse, collapsing a specific, useful message ("Invalid file
// type...", a size limit) into a generic fallback like "Upload failed."
// This restores the specific message as JSON instead.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'This file is too large. Please choose a smaller file.'
        : err.message;
    return res.status(400).json({ message });
  }

  if (err instanceof Error) {
    // Any other middleware-level error (e.g. a rejected file type from a
    // fileFilter, or the CORS check above). These already carry a
    // message written for the person using the app, so it's passed
    // through as-is rather than replaced with something generic.
    console.error('Request rejected before reaching a route handler:', err.message);
    return res.status(400).json({ message: err.message });
  }

  console.error('Unhandled request error:', err);
  return res.status(500).json({ message: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 5000;
const httpServer = http.createServer(app);
attachSocketServer(httpServer);

// Test connection and boot application
async function main() {
  try {
    await prisma.$connect();
    console.log('PostgreSQL database connected successfully via Prisma ORM.');
    httpServer.listen(PORT, () => console.log(`Study2Gate Platform running on port ${PORT}`));
    // Keeps streaks accurate (afternoon warning, eventual reset) even
    // while nobody's actively using the app — see services/streakScheduler.js.
    startStreakScheduler();
  } catch (e) {
    console.error('Database connection initialization failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
