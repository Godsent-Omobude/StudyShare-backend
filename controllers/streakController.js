import prisma from "../config/prisma.js";

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

// Calendar-day key in UTC, e.g. "2026-08-21". Streaks are tracked by
// calendar day rather than exact timestamps.
const toDateKey = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: process.env.APP_TIMEZONE || "Africa/Lagos" }).format(new Date(date));

const daysBetweenKeys = (fromKey, toKey) => {
  const from = new Date(`${fromKey}T00:00:00Z`);
  const to = new Date(`${toKey}T00:00:00Z`);
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
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
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: streakSelect
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    return res.status(200).json({
      success: true,
      streak: serializeStreak(user)
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

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: streakSelect
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

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
        streak: serializeStreak(user)
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
      streak: serializeStreak(updatedUser)
    });
  } catch (error) {
    console.error("Record study session error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to update streak."
    });
  }
};
