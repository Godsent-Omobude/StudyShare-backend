import { buildFlashcardPrompt } from "./promptBuilder.js";
import { parseFlashcardsResponse } from "./responseParser.js";
import { ProviderError, classifyError } from "./providerError.js";

// NOTE: OpenRouter's free-tier model catalogue changes over time — verify
// this slug is still current at https://openrouter.ai/models before
// relying on it, and update OPENROUTER_MODEL if it's been retired.
const MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// OpenRouter routes to third-party model hosts, so it can be slower than
// hitting a provider directly — give it more headroom than Groq before
// treating a hang as transient.
const REQUEST_TIMEOUT_MS = 45000;

export const PROVIDER_NAME = "OpenRouter";
export const isConfigured = () => Boolean(process.env.OPENROUTER_API_KEY);

export async function generateFlashcards(documentText, count, difficulty) {
  const prompt = buildFlashcardPrompt(documentText, count, difficulty);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        // Recommended (not strictly required) by OpenRouter so requests
        // are attributable in their dashboard — harmless if generic.
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://study2gate.app",
        "X-Title": process.env.OPENROUTER_APP_NAME || "Study2Gate",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const { kind } = classifyError(error);
    throw new ProviderError(error.message || "OpenRouter request failed.", {
      provider: PROVIDER_NAME,
      kind,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let bodyMessage = "";
    try {
      const body = await res.json();
      bodyMessage = body?.error?.message || "";
    } catch {
      // Non-JSON error body — fall back to the status text below.
    }
    const { kind } = classifyError(new Error(bodyMessage || res.statusText), res.status);
    throw new ProviderError(bodyMessage || `OpenRouter request failed with status ${res.status}.`, {
      provider: PROVIDER_NAME,
      kind,
      statusCode: res.status,
    });
  }

  const data = await res.json();
  // Different OpenRouter-hosted models occasionally shape responses
  // slightly differently; this covers the standard chat-completions shape
  // every model on the platform is required to conform to.
  const output = data?.choices?.[0]?.message?.content?.trim();

  if (!output) {
    throw new ProviderError("OpenRouter returned an empty response.", {
      provider: PROVIDER_NAME,
      kind: "invalid_output",
    });
  }

  return parseFlashcardsResponse(output, PROVIDER_NAME);
}
