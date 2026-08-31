import { ProviderError } from "./providerError.js";

// Strips accidental markdown code fences some models add despite being
// told not to.
function stripCodeFences(text) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// A provider occasionally wraps the array in prose ("Here is your JSON:
// [...]") despite instructions not to. As a repair step (not a first
// resort), try extracting the outermost [ ... ] span before giving up.
function extractJsonArraySpan(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

// Parses and validates a provider's raw text response into a clean
// { front, back } array. Never throws a raw parser error outward — always
// a classified ProviderError with kind "invalid_output", so the manager
// treats it as "this provider's attempt failed" and moves on, per the
// project's requirement to never save malformed flashcards.
export function parseFlashcardsResponse(rawText, providerName) {
  const cleaned = stripCodeFences(String(rawText || "").trim());

  if (!cleaned) {
    throw new ProviderError("Empty response.", { provider: providerName, kind: "invalid_output" });
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const repaired = extractJsonArraySpan(cleaned);
    if (!repaired) {
      throw new ProviderError("Response was not valid JSON.", { provider: providerName, kind: "invalid_output" });
    }
    try {
      parsed = JSON.parse(repaired);
    } catch {
      throw new ProviderError("Response could not be safely parsed as JSON.", {
        provider: providerName,
        kind: "invalid_output",
      });
    }
  }

  if (!Array.isArray(parsed)) {
    throw new ProviderError("Response was not a JSON array.", { provider: providerName, kind: "invalid_output" });
  }

  const flashcards = parsed
    .filter((card) => card && typeof card.front === "string" && typeof card.back === "string")
    .map((card) => ({ front: card.front.trim(), back: card.back.trim() }))
    .filter((card) => card.front && card.back);

  if (!flashcards.length) {
    throw new ProviderError("Response contained no valid flashcards.", {
      provider: providerName,
      kind: "invalid_output",
    });
  }

  return flashcards;
}
