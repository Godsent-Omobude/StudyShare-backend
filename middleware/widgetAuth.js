import { verifyWidgetToken } from "../utils/token.js";

// Separate from protect() in middleware/auth.js on purpose. The widget
// runs in the background and refreshes on its own schedule, so it can't
// rely on the 15-minute httpOnly auth cookie (see utils/cookies.js)
// staying valid. This reads a long-lived widget-only Bearer token instead
// — scoped by its "purpose" claim (see utils/token.js) so it can never be
// used against any other /api route even if intercepted.
export const widgetAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: "Missing widget token." });
  }

  try {
    const decoded = verifyWidgetToken(token);
    req.user = { id: decoded.id };
    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired widget token." });
  }
};
