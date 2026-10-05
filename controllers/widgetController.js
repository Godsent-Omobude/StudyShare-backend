import prisma from "../config/prisma.js";
import { createWidgetToken } from "../utils/token.js";
import { resolveStreak, serializeStreak } from "./streakController.js";

const streakSelect = {
  currentStreak: true,
  longestStreak: true,
  lastStudyDate: true,
  totalStudyDays: true,
};

// Called once, right after login, by the native app — not by the widget
// itself. Mints the long-lived token the widget will use from then on.
// Protected by the normal cookie-based `protect` middleware, so only an
// already-authenticated session can request one.
export const mintWidgetToken = async (req, res) => {
  try {
    const token = createWidgetToken({ id: req.user.id });
    return res.status(200).json({ success: true, token });
  } catch (error) {
    console.error("Mint widget token error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to create widget token.",
    });
  }
};

// Read-only streak fetch for the widget. Authenticated by widgetAuth
// (Bearer token), not the cookie — see middleware/widgetAuth.js. Reuses
// the same resolveStreak/serializeStreak logic as the in-app streak
// endpoint (controllers/streakController.js) so both report identical
// numbers and status.
export const getWidgetStreak = async (req, res) => {
  try {
    const rawUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: streakSelect,
    });

    if (!rawUser) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const { user, status } = await resolveStreak(req.user.id, rawUser);

    return res.status(200).json({
      success: true,
      streak: serializeStreak(user, { status }),
    });
  } catch (error) {
    console.error("Get widget streak error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to load streak.",
    });
  }
};
