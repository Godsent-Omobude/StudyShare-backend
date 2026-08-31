// Token estimation is intentionally simple and provider-agnostic: Gemini,
// Groq, and OpenRouter models each use different tokenizers, and we don't
// know which provider will actually end up serving a given chunk until
// the fallback chain runs. Rather than depend on any one provider's exact
// tokenizer, we use a conservative character-based approximation and pick
// a MAX_INPUT_TOKENS budget conservative enough to hold up across all
// three, plus room for the prompt instructions and the model's output.
//
// Approximation: ~4 characters per token for English prose. This is the
// same rule of thumb OpenAI/Anthropic publish for rough sizing (see e.g.
// https://platform.openai.com/tokenizer) — it tends to slightly
// *overestimate* token count for plain English text, which is the safe
// direction to err in here (we'd rather chunk slightly more than
// necessary than risk exceeding a model's context window).
const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// The budget for *document text* in a single AI request — not the
// model's total context window. It deliberately leaves headroom above
// itself for the fixed prompt instructions and the model's JSON output,
// and is kept conservative enough to be safe across all three providers,
// including smaller-context free-tier models on OpenRouter, not just
// Gemini's much larger window.
export const MAX_INPUT_TOKENS = envInt("MAX_INPUT_TOKENS", 6000);

// Overlap between adjacent chunks, so a concept split across a chunk
// boundary isn't lost entirely from either chunk's context. Defaults to
// ~8% of the chunk budget — enough to preserve a sentence or two of lead-in
// context without meaningfully inflating token usage per chunk.
export const CHUNK_OVERLAP_TOKENS = envInt(
  "CHUNK_OVERLAP_TOKENS",
  Math.max(50, Math.round(MAX_INPUT_TOKENS * 0.08))
);

// Hard ceiling on how many chunks one document can be split into, so a
// pathologically large upload can't trigger dozens of sequential AI
// requests (cost and request-time risk). Text beyond this many chunks is
// simply not sent to the AI — see textChunker.js.
export const MAX_CHUNKS = envInt("MAX_CHUNKS", 12);
