import { cleanText, chunkText, distributeCount } from "./textChunker.js";
import { estimateTokens, MAX_INPUT_TOKENS, CHUNK_OVERLAP_TOKENS } from "./tokenManager.js";
import { dedupeFlashcards } from "./dedupe.js";
import * as geminiProvider from "./geminiProvider.js";
import * as groqProvider from "./groqProvider.js";
import * as openrouterProvider from "./openrouterProvider.js";

// Fixed order per spec: Gemini is primary; Groq and OpenRouter are
// fallbacks, tried only when the one before it fails for a
// provider-related (not our-own-request) reason.
const PROVIDERS = [geminiProvider, groqProvider, openrouterProvider];

// One short retry for transient network/server hiccups only — never for
// quota/auth issues, which won't resolve within the same request. Keeps
// this bounded so a flaky provider can't turn into a retry storm.
const TRANSIENT_RETRY_DELAY_MS = 500;

function log(message) {
  console.log(`[AI] ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Attempts one chunk against the provider chain, in order. `exhausted` is
// a Set shared across all chunks in this request — once a provider is
// known to be quota-exhausted or unconfigured, later chunks skip it
// immediately rather than re-discovering the same failure repeatedly.
async function generateForChunk(text, count, difficulty, exhausted) {
  for (const provider of PROVIDERS) {
    const { PROVIDER_NAME: name, isConfigured, generateFlashcards: call } = provider;

    if (exhausted.has(name)) {
      continue;
    }

    if (!isConfigured()) {
      // Missing key is a configuration problem, not a runtime failure —
      // log once per request and never attempt this provider again this
      // request. The key itself is never logged, only that it's missing.
      if (!exhausted.has(name)) {
        log(`${name} is not configured (missing API key) — skipping.`);
        exhausted.add(name);
      }
      continue;
    }

    log(`Trying ${name}`);

    let lastError;
    // Up to two attempts, and only the second attempt is for a transient
    // (not quota/auth/client) failure — see the retry-classification
    // comment on ProviderError.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const flashcards = await call(text, count, difficulty);
        log(`${name} succeeded`);
        return flashcards;
      } catch (error) {
        lastError = error;
        const kind = error?.kind || "transient";

        if (kind === "quota") {
          log(`${name} rate limit / quota reached — will not retry this provider this request.`);
          exhausted.add(name);
          break;
        }
        if (kind === "auth") {
          log(`${name} unavailable (authentication/configuration problem).`);
          exhausted.add(name);
          break;
        }
        if (kind === "client") {
          // Per spec: our own malformed request — don't cascade through
          // every provider with the same broken input. Stop entirely for
          // this chunk rather than trying Groq/OpenRouter with it too.
          log(`${name} rejected the request (client error) — not retrying with other providers for this chunk.`);
          throw error;
        }
        if (kind === "invalid_output") {
          log(`${name} returned output that could not be safely parsed — moving on.`);
          break;
        }
        // transient
        if (attempt === 1) {
          log(`${name} had a transient failure — retrying once.`);
          await sleep(TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        log(`${name} unavailable.`);
      }
    }

    const nextProvider = PROVIDERS[PROVIDERS.indexOf(provider) + 1];
    if (nextProvider) {
      log(`Falling back to ${nextProvider.PROVIDER_NAME}`);
    }
    void lastError; // already logged above; kept for readability/debug if extended later
  }

  return [];
}

// Main entry point — same signature/contract as the original
// single-provider generateFlashcards(documentText, count, difficulty):
// resolves to an array of { front, back }. Throws only when every chunk
// exhausted every provider, with a clean user-facing message (never a raw
// provider error, stack trace, or key).
export async function generateFlashcards(documentText, count, difficulty) {
  if (!documentText || !documentText.trim()) {
    throw new Error("Document contains no readable text.");
  }

  const cleaned = cleanText(documentText);
  const totalTokens = estimateTokens(cleaned);
  const chunks =
    totalTokens <= MAX_INPUT_TOKENS
      ? [cleaned]
      : chunkText(cleaned, { maxTokens: MAX_INPUT_TOKENS, overlapTokens: CHUNK_OVERLAP_TOKENS });

  if (chunks.length > 1) {
    log(`Document is large (~${totalTokens} estimated tokens) — split into ${chunks.length} chunks.`);
  }

  const perChunkCounts = distributeCount(count, chunks.length);
  const exhausted = new Set();
  const collected = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const target = perChunkCounts[i];
    if (target < 1) continue;

    if (chunks.length > 1) {
      log(`Generating ~${target} flashcards from chunk ${i + 1}/${chunks.length}.`);
    }

    try {
      const flashcards = await generateForChunk(chunks[i], target, difficulty, exhausted);
      collected.push(...flashcards);
    } catch (error) {
      if (error?.kind === "client") {
        // Our own request was malformed for this chunk — surface
        // immediately rather than silently dropping it, since it likely
        // indicates a real bug (e.g. a bad prompt) worth fixing, not
        // routine provider flakiness.
        throw new Error("The request could not be processed. Please try again.");
      }
      // Any other unexpected throw from a chunk: treat as that chunk
      // contributing nothing, and continue with the rest of the document.
      log(`Chunk ${i + 1} failed unexpectedly: ${error?.message || error}`);
    }
  }

  const deduped = dedupeFlashcards(collected);
  const finalCards = deduped.slice(0, count);

  if (!finalCards.length) {
    // Every chunk exhausted every provider. Never leak raw provider
    // errors/keys to the frontend — a clean, generic message only. The
    // technical reason for each failure was already logged above.
    throw new Error("AI flashcard generation is temporarily unavailable. Please try again later.");
  }

  return finalCards;
}
