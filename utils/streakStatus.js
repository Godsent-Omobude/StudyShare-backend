// Pure helpers for "what does this user's streak look like right now,
// independent of whether they've opened a study session today". Shared by
// controllers/streakController.js (the request-time path) and
// services/streakScheduler.js (the background job) so both agree on
// exactly the same rules.

export const APP_TIMEZONE = process.env.APP_TIMEZONE || "Africa/Lagos";

// Local hour (0–23, APP_TIMEZONE) at/after which a not-yet-studied "streak
// day" counts as "afternoon" for the at-risk warning.
export const AFTERNOON_START_HOUR = 12;

// Calendar-day key in APP_TIMEZONE, e.g. "2026-08-21". Streaks are tracked
// by calendar day rather than exact timestamps.
export const toDateKey = (date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(new Date(date));

export const daysBetweenKeys = (fromKey, toKey) => {
  const from = new Date(`${fromKey}T00:00:00Z`);
  const to = new Date(`${toKey}T00:00:00Z`);
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
};

export const currentHourInAppTimezone = (date = new Date()) =>
  Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, hour: "numeric", hourCycle: "h23" }).format(date)
  );

// Works out how the streak looks *right now*, independent of whether the
// user has opened a study session today.
//
//   "none"    — no active streak to protect.
//   "safe"    — already studied today.
//   "pending" — haven't studied today, but it's still morning; no warning.
//   "at_risk" — haven't studied today, it's afternoon+ — one more missed
//               day and the streak breaks.
//   "broken"  — a full day went by with no session; the streak is already
//               gone. resetNeeded tells the caller to persist that.
export const evaluateStreakStatus = (user, now = new Date()) => {
  if (!user.lastStudyDate || user.currentStreak <= 0) {
    return { status: "none", resetNeeded: false };
  }

  const todayKey = toDateKey(now);
  const lastKey = toDateKey(user.lastStudyDate);
  const gap = daysBetweenKeys(lastKey, todayKey);

  if (gap <= 0) {
    return { status: "safe", resetNeeded: false };
  }

  if (gap === 1) {
    const hour = currentHourInAppTimezone(now);
    return {
      status: hour >= AFTERNOON_START_HOUR ? "at_risk" : "pending",
      resetNeeded: false
    };
  }

  // gap >= 2: an entire day passed with no qualifying session, so the
  // streak already broke.
  return { status: "broken", resetNeeded: true };
};
