// Server-side rate limiting for the login endpoint to slow down brute-force
// attacks. Deliberately dependency-free (simple in-memory sliding window)
// since the project has no rate-limiting package installed yet.
//
// Only FAILED login attempts count against the limit — call
// recordFailedAttempt() after a bad username/password and
// resetAttempts() after a successful login so legitimate users are never
// penalised for their own successful sign-in.
//
// Note: this in-memory store is per-process. If the backend is ever run
// behind multiple processes/instances, replace this with a shared store
// (e.g. Redis) to keep the limit consistent across instances.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

const attemptsByKey = new Map();

const getClientKey = (req) => req.ip || req.connection?.remoteAddress || "unknown";

const pruneOldAttempts = (timestamps, now) =>
  timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);

export const loginRateLimiter = (req, res, next) => {
  const key = getClientKey(req);
  const now = Date.now();

  const timestamps = pruneOldAttempts(attemptsByKey.get(key) || [], now);
  attemptsByKey.set(key, timestamps);

  if (timestamps.length >= MAX_ATTEMPTS) {
    const retryAfterMs = WINDOW_MS - (now - timestamps[0]);
    res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000));
    return res.status(429).json({
      message: "Too many login attempts. Please try again later.",
    });
  }

  req.rateLimitKey = key;
  return next();
};

export const recordFailedAttempt = (req) => {
  const key = req.rateLimitKey || getClientKey(req);
  const now = Date.now();
  const timestamps = pruneOldAttempts(attemptsByKey.get(key) || [], now);
  timestamps.push(now);
  attemptsByKey.set(key, timestamps);
};

export const resetAttempts = (req) => {
  const key = req.rateLimitKey || getClientKey(req);
  attemptsByKey.delete(key);
};
