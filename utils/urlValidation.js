// Validation for the "External resource link" feature (routes/files.js).
//
// Study2Gate never fetches, proxies, or executes anything from an external
// URL — it only ever stores it and renders a plain <a target="_blank"
// rel="noopener noreferrer"> link. That said, the backend is still the
// last line of defense: the frontend check is easily bypassed by anyone
// calling the API directly, so every external URL is re-validated here
// before it's ever written to the database.

const MAX_URL_LENGTH = 2048;

// Only a real web address is ever accepted. Anything else — javascript:,
// data:, file:, vbscript:, or a bare non-HTTPS address — is rejected
// outright rather than "cleaned up", since silently rewriting a
// dangerous scheme could still leave something exploitable.
const ALLOWED_PROTOCOL = "https:";

const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0"]);

// Cheap check for the common private/loopback IPv4 ranges. This isn't
// meant to be a bulletproof SSRF filter (Study2Gate never makes a
// server-side request to the URL, so there's no SSRF vector to begin
// with) — it's just an extra guard against obviously-wrong submissions
// like an internal address pasted by mistake.
const isPrivateIPv4 = (hostname) => {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
};

// Throws a plain Error with a user-safe message on anything invalid.
// Returns { normalizedUrl, domain } on success.
export const validateExternalUrl = (rawUrl) => {
  const value = typeof rawUrl === "string" ? rawUrl.trim() : "";

  if (!value) {
    throw new Error("Please provide a resource URL.");
  }

  if (value.length > MAX_URL_LENGTH) {
    throw new Error("That resource URL is too long.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Please enter a valid resource URL.");
  }

  if (parsed.protocol !== ALLOWED_PROTOCOL) {
    throw new Error("External resources must use a secure HTTPS URL.");
  }

  const hostname = parsed.hostname.toLowerCase();

  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || isPrivateIPv4(hostname)) {
    throw new Error("Please enter a valid resource URL.");
  }

  return {
    normalizedUrl: parsed.toString(),
    domain: hostname.replace(/^www\./, ""),
  };
};
