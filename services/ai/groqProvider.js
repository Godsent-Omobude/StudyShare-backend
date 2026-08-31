import { buildFlashcardPrompt } from "./promptBuilder.js";
import { parseFlashcardsResponse } from "./responseParser.js";
import { ProviderError, classifyError } from "./providerError.js";

const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
// Groq requests are usually fast; this bounds how long we wait before
// treating a hung request as a transient failure and moving on.
const REQUEST_TIMEOUT_MS = 30000;

export const PROVIDER_NAME = "Groq";
export const isConfigured = () => Boolean(process.env.GROQ_API_KEY);

export async function generateFlashcards(documentText, count, difficulty) {
  const prompt = buildFlashcardPrompt(documentText, count, difficulty);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
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
    throw new ProviderError(error.message || "Groq request failed.", {
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
    throw new ProviderError(bodyMessage || `Groq request failed with status ${res.status}.`, {
      provider: PROVIDER_NAME,
      kind,
      statusCode: res.status,
    });
  }

  const data = await res.json();
  const output = data?.choices?.[0]?.message?.content?.trim();

  if (!output) {
    throw new ProviderError("Groq returned an empty response.", {
      provider: PROVIDER_NAME,
      kind: "invalid_output",
    });
  }

  return parseFlashcardsResponse(output, PROVIDER_NAME);
}
