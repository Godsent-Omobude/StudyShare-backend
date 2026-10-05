import express from "express";
import { protect } from "../middleware/auth.js";
import { widgetAuth } from "../middleware/widgetAuth.js";
import { mintWidgetToken, getWidgetStreak } from "../controllers/widgetController.js";

const router = express.Router();

// Called by the native app right after login, using the normal session
// cookie — mints the long-lived token the widget will use afterward.
router.post("/token", protect, mintWidgetToken);

// Called by the widget itself on its refresh schedule, using the
// long-lived Bearer token minted above instead of the cookie.
router.get("/streak", widgetAuth, getWidgetStreak);

export default router;
