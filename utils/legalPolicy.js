// Single source of truth for "which version of the Copyright Policy is
// currently in force". Bumping this string (e.g. to a new date) instantly
// requires every user — new and existing — to re-accept the next time they
// try to log in or use the app, since acceptance is compared against this
// value everywhere (see routes/auth.js and middleware/auth.js).
export const CURRENT_COPYRIGHT_POLICY_VERSION = "2026-08-30";

// True when a user record's stored acceptance matches the currently
// in-force policy version.
export const hasAcceptedCurrentCopyrightPolicy = (user) =>
  Boolean(user?.copyrightPolicyAcceptedAt) &&
  user?.copyrightPolicyVersion === CURRENT_COPYRIGHT_POLICY_VERSION;
