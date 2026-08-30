// Background sweep that keeps streaks accurate even while nobody's using
// the app — i.e. it acts on its own schedule instead of waiting for a
// user's next request. (See resolveStreak() in controllers/streakController.js
// for the request-time equivalent, which this backs up: if the sweep
// hasn't reached a user yet, their very next /ai/streak call still
// resolves it correctly.)
//
// Two things happen here, once per user with an active streak:
//   1. The first time a user crosses into "at_risk" for the day (haven't
//      studied yet, it's afternoon+), send one "Study now to keep your
//      streak" notification/push for that day.
//   2. The first time a user's streak actually breaks (a full day passed
//      with no session), reset currentStreak to 0 and send one
//      "your streak ended" notification.
//
// No new dependency is pulled in for this — a single setInterval is
// plenty for an app this size (see middleware/rateLimiter.js for the same
// dependency-free philosophy). If this ever needs to run across multiple
// backend instances, replace it with a real job scheduler / distributed
// lock so the sweep doesn't run redundantly on every instance.

import prisma from "../config/prisma.js";
import { evaluateStreakStatus, toDateKey } from "../utils/streakStatus.js";
import { emitToUser } from "./circleRealtime.js";
import { sendPushForNotification } from "./pushNotificationService.js";

// How often the sweep runs. Frequent enough that the afternoon warning and
// the eventual reset both land within a reasonable window of when they
// become true, without hammering the database.
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
// Give the server a moment to finish booting before the first sweep.
const INITIAL_DELAY_MS = 60 * 1000;

const streakSelect = {
  id: true,
  currentStreak: true,
  longestStreak: true,
  lastStudyDate: true,
  totalStudyDays: true,
};

// Creates + emits + pushes a notification only if one with this exact
// groupKey doesn't already exist. The unique constraint on
// Notification.groupKey makes this race-safe (an "already sent today"
// attempt just fails with P2002) even if two sweeps somehow overlap, so
// callers don't need their own locking.
const notifyOnce = async ({ userId, type, title, body, groupKey }) => {
  try {
    const notification = await prisma.notification.create({
      data: { userId, type, title, body, groupKey },
    });
    emitToUser(userId, "notification:new", notification);
    // Fire-and-forget, same as everywhere else notifications are created —
    // a push/Firebase hiccup must never break the sweep.
    sendPushForNotification(notification);
  } catch (error) {
    if (error?.code === "P2002") return; // Already sent today — expected, not an error.
    console.error("[streakScheduler] Failed to send streak notification:", error.message);
  }
};

// The core logic, exported separately from the interval wiring so it can
// be invoked directly (e.g. from a one-off script or a test) without
// waiting on the timer.
export const runStreakSweep = async (now = new Date()) => {
  const usersWithActiveStreaks = await prisma.user.findMany({
    where: { currentStreak: { gt: 0 } },
    select: streakSelect,
  });

  const todayKey = toDateKey(now);

  await Promise.all(
    usersWithActiveStreaks.map(async (user) => {
      const { status, resetNeeded } = evaluateStreakStatus(user, now);

      if (status === "at_risk") {
        await notifyOnce({
          userId: user.id,
          type: "STREAK_AT_RISK",
          title: "Don't lose your streak! \u{1F525}",
          body: `Study now to keep your ${user.currentStreak}-day streak alive.`,
          groupKey: `STREAK_AT_RISK:${user.id}:${todayKey}`,
        });
        return;
      }

      if (resetNeeded) {
        const brokenStreak = user.currentStreak;

        await prisma.user.update({
          where: { id: user.id },
          data: { currentStreak: 0 },
        });

        await notifyOnce({
          userId: user.id,
          type: "STREAK_BROKEN",
          title: "Your streak has ended",
          body: `Your ${brokenStreak}-day streak reset. Review at least 5 flashcards today to start a new one.`,
          groupKey: `STREAK_BROKEN:${user.id}:${todayKey}`,
        });
      }
    })
  );
};

let started = false;
let intervalHandle = null;

// Called once from server.js after the app boots. Safe to call more than
// once — only the first call actually schedules anything.
export const startStreakScheduler = () => {
  if (started) return;
  started = true;

  setTimeout(() => {
    runStreakSweep().catch((error) => console.error("[streakScheduler] Sweep failed:", error.message));

    intervalHandle = setInterval(() => {
      runStreakSweep().catch((error) => console.error("[streakScheduler] Sweep failed:", error.message));
    }, SWEEP_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
};

// Exposed for tests / graceful shutdown — not currently called elsewhere.
export const stopStreakScheduler = () => {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
};
