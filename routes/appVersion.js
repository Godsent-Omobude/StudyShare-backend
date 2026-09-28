import express from "express";

// Public (no auth) so the native Android app can check for a newer version
// on launch — including before anyone has signed in. Everything comes from
// environment variables, so publishing a new APK only means updating those
// on the host; no code change or database migration is involved.
//
//   APP_LATEST_VERSION_CODE  integer versionCode of the newest APK
//                            (android/app/build.gradle -> versionCode).
//                            Leave unset to switch update prompts off.
//   APP_LATEST_VERSION_NAME  human-friendly name shown to users, e.g. "1.2.0"
//   APP_MIN_VERSION_CODE     optional — installs older than this are forced
//                            to update (the prompt can't be dismissed)
//   APP_DOWNLOAD_URL         https link to the APK or Play Store listing
//   APP_RELEASE_NOTES        optional short "what's new" text
const router = express.Router();

const toPositiveInt = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

router.get("/", (req, res) => {
  // Never cache: a stale answer here would hide a new release.
  res.set("Cache-Control", "no-store");

  const latestVersionCode = toPositiveInt(process.env.APP_LATEST_VERSION_CODE);
  if (!latestVersionCode) {
    return res.json({ configured: false });
  }

  return res.json({
    configured: true,
    latestVersionCode,
    latestVersionName: process.env.APP_LATEST_VERSION_NAME || null,
    minVersionCode: toPositiveInt(process.env.APP_MIN_VERSION_CODE),
    downloadUrl: process.env.APP_DOWNLOAD_URL || null,
    releaseNotes: process.env.APP_RELEASE_NOTES || null,
  });
});

export default router;
