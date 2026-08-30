// Generic, dependency-free in-memory rate limiter. Used to protect the
// login, registration, password-reset-request, and AI-generation endpoints
// against brute-force/abuse without adding a new npm package.
//
// Two usage modes:
//   - manual: false (default) — every request that passes the check counts
//     against the limit immediately (e.g. registration, forgot-password).
//   - manual: true — the caller decides what counts, by calling
//     recordAttempt() explicitly (e.g. login, where only FAILED attempts
//     should count so a legitimate user is never penalised for signing in
//     successfully). Call reset() on success to clear their history.
//
// Note: this in-memory store is per-process. If the backend ever runs as
// multiple processes/instances, replace this with a shared store (e.g.
// Redis) to keep limits consistent across instances.

export const createRateLimiter = ({ windowMs, max, keyPrefix, message, manual = false }) => {
  const store = new Map();

  const keyFor = (req) => `${keyPrefix}:${req.ip || req.connection?.remoteAddress || "unknown"}`;

  const currentTimestamps = (key, now) =>
    (store.get(key) || []).filter((timestamp) => now - timestamp < windowMs);

  const middleware = (req, res, next) => {
    const key = keyFor(req);
    const now = Date.now();
    const timestamps = currentTimestamps(key, now);

    if (timestamps.length >= max) {
      store.set(key, timestamps);
      const retryAfterMs = windowMs - (now - timestamps[0]);
      res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000));
      return res.status(429).json({
        message: message || "Too many requests. Please try again later.",
      });
    }

    if (!manual) {
      timestamps.push(now);
    }

    store.set(key, timestamps);
    req._rateLimiterKeys = req._rateLimiterKeys || {};
    req._rateLimiterKeys[keyPrefix] = key;
    return next();
  };

  const recordAttempt = (req) => {
    const key = req._rateLimiterKeys?.[keyPrefix] || keyFor(req);
    const now = Date.now();
    const timestamps = currentTimestamps(key, now);
    timestamps.push(now);
    store.set(key, timestamps);
  };

  const reset = (req) => {
    const key = req._rateLimiterKeys?.[keyPrefix] || keyFor(req);
    store.delete(key);
  };

  return { middleware, recordAttempt, reset };
};

export const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyPrefix: "login",
  message: "Too many login attempts. Please try again later.",
  manual: true,
});

export const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyPrefix: "register",
  message: "Too many registration attempts from this network. Please try again later.",
});

export const forgotPasswordLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyPrefix: "forgot-password",
  message: "Too many password reset requests. Please try again later.",
});

// Manual mode: only failed code attempts count, so a legitimate user
// re-requesting the page isn't penalised — mirrors loginLimiter.
export const verifyEmailLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyPrefix: "verify-email",
  message: "Too many verification attempts. Please try again later.",
  manual: true,
});

export const resendVerificationLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 4,
  keyPrefix: "resend-verification",
  message: "Too many verification code requests. Please try again later.",
});

export const aiGenerationLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyPrefix: "ai-generate",
  message: "Too many flashcard generation requests. Please try again later.",
});

// Copyright reports and disputes are free-text forms an abusive actor
// could otherwise spam to harass an uploader or flood the review queue.
export const copyrightReportLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyPrefix: "copyright-report",
  message: "Too many copyright reports submitted. Please try again later.",
});

export const copyrightDisputeLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyPrefix: "copyright-dispute",
  message: "Too many disputes submitted. Please try again later.",
});
