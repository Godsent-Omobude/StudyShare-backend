// Minimal cookie helpers for the httpOnly auth cookie. Written by hand
// instead of adding the `cookie-parser` package, since this is the only
// cookie the app needs to read.

const AUTH_COOKIE_NAME = "token";

// REST calls now go through the frontend's own domain (see
// frontend/vercel.json, which proxies /api to Render), so for those the
// cookie is same-origin as far as the browser is concerned. But the
// Socket.IO connection (socket.js) still connects to Render directly and
// depends on this same cookie riding along cross-site — so SameSite=None
// still has to stay in production, or that direct connection breaks on
// every browser, not just Safari. None also still permits it on the now
// same-origin REST calls (None is the most permissive value), so this is
// safe for both. Secure only applies in production (requires HTTPS); it
// falls back to Lax locally (http://localhost) so cookie-based login still
// works in dev.
const isProduction = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";

const cookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
});

// Parses the raw `Cookie` request header into an object. Express does not
// populate req.cookies unless cookie-parser middleware is installed, so
// routes/middleware that need the cookie should use this instead.
export const parseCookies = (cookieHeader) => {
  const result = {};
  if (!cookieHeader) return result;

  for (const pair of cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }

  return result;
};

export const getAuthCookie = (req) => parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME];

// How long a session survives with no activity at all. Sliding: every
// authenticated request resets this window (see protect() in
// middleware/auth.js), so an active user's cookie never actually reaches
// this age — only genuine inactivity does.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export const setAuthCookie = (res, token) => {
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...cookieOptions(),
    maxAge: IDLE_TIMEOUT_MS,
  });
};

export const clearAuthCookie = (res) => {
  res.clearCookie(AUTH_COOKIE_NAME, cookieOptions());
};
