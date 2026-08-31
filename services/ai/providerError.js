// A normalised error shape every provider throws, so aiProviderManager.js
// can decide what to do next (retry, skip to the next provider, or abort)
// without needing to know each SDK/API's individual error format.
//
// kind:
//   "quota"         - rate limit / quota / insufficient credits — do not
//                      retry this provider again during this request.
//   "transient"     - network/server hiccup — safe for one short retry
//                      before moving on.
//   "auth"          - missing/invalid API key or other config problem —
//                      this provider is unusable for the rest of this
//                      request; never retried, and the detail is never
//                      logged (only that it happened).
//   "client"        - our own request was malformed (e.g. HTTP 400) —
//                      per spec, this is NOT blindly retried across every
//                      provider, since the same bad input would likely
//                      fail everywhere.
//   "invalid_output" - the provider responded, but its output couldn't be
//                      safely parsed/validated into flashcards — treated
//                      as a failed attempt, falls through to the next
//                      provider.
export class ProviderError extends Error {
  constructor(message, { provider, kind, statusCode, cause } = {}) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind || "transient";
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

const QUOTA_PATTERN = /rate.?limit|quota|resource exhausted|resource_exhausted|insufficient.*credit|too many requests/i;
const TRANSIENT_PATTERN = /temporarily unavailable|overloaded|timeout|timed out|network|econnreset|enotfound|etimedout|econnrefused|fetch failed|socket hang up|service unavailable|bad gateway|gateway timeout/i;
const AUTH_PATTERN = /invalid api key|unauthorized|authentication|api key not valid|no api key|missing api key|forbidden/i;

// Classifies an error from any provider (HTTP status if we have one, plus
// the error message text as a fallback for SDKs that don't surface a
// clean status code) into one of the ProviderError kinds above.
export function classifyError(error, statusCode) {
  const status = statusCode ?? error?.status ?? error?.statusCode ?? error?.response?.status;
  const message = String(error?.message || error || "");

  if (status === 429 || QUOTA_PATTERN.test(message)) {
    return { kind: "quota", statusCode: status };
  }
  if (status === 401 || status === 403 || AUTH_PATTERN.test(message)) {
    return { kind: "auth", statusCode: status };
  }
  if (status === 400) {
    return { kind: "client", statusCode: status };
  }
  if ([500, 502, 503, 504].includes(status) || TRANSIENT_PATTERN.test(message)) {
    return { kind: "transient", statusCode: status };
  }
  // Unclassified errors are treated as transient — safer to give a
  // provider one retry / fall through to the next than to abort the
  // whole request over an error shape we don't recognise.
  return { kind: "transient", statusCode: status };
}
