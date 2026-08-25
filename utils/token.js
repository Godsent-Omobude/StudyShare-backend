import jwt from "jsonwebtoken";

// The JWT itself stays valid for a full day — that's just a safety cap.
// The actual "log out after being idle" behaviour comes from the cookie's
// own expiry, which protect() below resets on every authenticated request
// (see setAuthCookie call). So: active user → cookie keeps sliding forward
// and never hits its 15-minute limit; idle 15+ minutes → the browser drops
// the cookie itself and the next request has no cookie to send.
export const JWT_EXPIRES_IN = "1d";

// tokenVersion is embedded in every token and checked against the user's
// stored tokenVersion on every request (see middleware/auth.js). Bumping
// the stored value (on password change/reset) instantly invalidates every
// previously-issued token, even ones that haven't expired yet — the
// revocation mechanism a plain JWT setup doesn't otherwise have.
export const createAuthToken = (user) =>
  jwt.sign(
    {
      id: user.id,
      fullName: user.fullName,
      role: user.role,
      tokenVersion: user.tokenVersion || 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
