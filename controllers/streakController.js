import prisma from "../config/prisma.js";
import { toDateKey, daysBetweenKeys, evaluateStreakStatus } from "../utils/streakStatus.js";

// A "study day" requires completing at least this many flashcards in a
// single session — either Normal Mode reviews or Test Yourself answers.
// Generating a set, or opening/browsing one without reviewing enough
// cards, does not count.
export const MIN_CARDS_FOR_STREAK = 5;

const streakSelect = {
  currentStreak: true,
  longestStreak: true,
  lastStudyDate: true,
  totalStudyDays: true
};

// Applies a pending reset (if any) and returns the up-to-date user record
// plus the status to report alongside it. Shared by getStreak and
// recordStudySession so both endpoints agree on the current state.
//
// This is also a safety net for however long the background job (see
// services/streakScheduler.js) takes to get to this user — a broken
// streak is reset here on the very next read/write even if the scheduler
// hasn't run yet.
const resolveStreak = async (userId, user, now = new Date()) => {
  const { status, resetNeeded } = evaluateStreakStatus(user, now);

  if (resetNeeded && user.currentStreak !== 0) {
    const resetUser = await prisma.user.update({
      where: { id: userId },
      data: { currentStreak: 0 },
      select: streakSelect
    });
    return { user: resetUser, status };
  }

  return { user, status };
};

const serializeStreak = (user, extra = {}) => ({
  currentStreak: user.currentStreak,
  longestStreak: user.longestStreak,
  totalStudyDays: user.totalStudyDays,
  lastStudyDate: user.lastStudyDate,
  ...extra
});

export const getStreak = async (req, res) => {
  try {
    const rawUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: streakSelect
    });

    if (!rawUser) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const { user, status } = await resolveStreak(req.user.id, rawUser);

    return res.status(200).json({
      success: true,
      streak: serializeStreak(user, { status })
    });
  } catch (error) {
    console.error("Get streak error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to load streak."
    });
  }
};

// Called once per study session, right when the qualifying number of
// cards is reached — not only when the user finishes the whole set. This
// way the streak is protected even if they close the browser immediately
// after studying.
export const recordStudySession = async (req, res) => {
  try {
    const completedCount = Number(req.body.completedCount);

    if (!Number.isInteger(completedCount) || completedCount < 0) {
      return res.status(400).json({
        success: false,
        message: "completedCount must be a valid number."
      });
    }

    const rawUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: streakSelect
    });

    if (!rawUser) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // Resolve any pending reset first, so a not-qualified/duplicate
    // response below reports the true (already-broken) streak rather than
    // a stale positive count.
    const { user } = await resolveStreak(req.user.id, rawUser);

    if (completedCount < MIN_CARDS_FOR_STREAK) {
      return res.status(200).json({
        success: true,
        qualified: false,
        message: `Complete at least ${MIN_CARDS_FOR_STREAK} flashcards in a session to count toward your streak.`,
        streak: serializeStreak(user)
      });
    }

    const todayKey = toDateKey(new Date());
    const lastKey = user.lastStudyDate ? toDateKey(user.lastStudyDate) : null;

    if (lastKey === todayKey) {
      // Already recorded today — this is a later qualifying session
      // (e.g. Normal Mode after Test Yourself) or a duplicate request.
      return res.status(200).json({
        success: true,
        qualified: true,
        streakUpdated: false,
        alreadyRecorded: true,
        streak: serializeStreak(user, { status: "safe" })
      });
    }

    const isConsecutiveDay = lastKey && daysBetweenKeys(lastKey, todayKey) === 1;
    const nextCurrentStreak = isConsecutiveDay ? user.currentStreak + 1 : 1;
    const nextLongestStreak = Math.max(user.longestStreak, nextCurrentStreak);

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        currentStreak: nextCurrentStreak,
        longestStreak: nextLongestStreak,
        totalStudyDays: user.totalStudyDays + 1,
        lastStudyDate: new Date()
      },
      select: streakSelect
    });

    return res.status(200).json({
      success: true,
      qualified: true,
      streakUpdated: true,
      alreadyRecorded: false,
      streak: serializeStreak(updatedUser, { status: "safe" })
    });
  } catch (error) {
    console.error("Record study session error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to update streak."
    });
  }
};

