import jwt from "jsonwebtoken";

// Single source of truth for how long an access token lives — previously
// this was 30d in one code path and 7d in another.
export const JWT_EXPIRES_IN = "7d";

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
