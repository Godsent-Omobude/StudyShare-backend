import ai from "../../config/gemini.js";
import { buildFlashcardPrompt } from "./promptBuilder.js";
import { parseFlashcardsResponse } from "./responseParser.js";
import { ProviderError, classifyError } from "./providerError.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

export const PROVIDER_NAME = "Gemini";
export const isConfigured = () => Boolean(process.env.GEMINI_API_KEY);

export async function generateFlashcards(documentText, count, difficulty) {
  const prompt = buildFlashcardPrompt(documentText, count, difficulty);

  let response;
  try {
    response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
    });
  } catch (error) {
    const { kind, statusCode } = classifyError(error);
    throw new ProviderError(error.message || "Gemini request failed.", {
      provider: PROVIDER_NAME,
      kind,
      statusCode,
      cause: error,
    });
  }

  const output = response?.text?.trim();
  if (!output) {
    throw new ProviderError("Gemini returned an empty response.", {
      provider: PROVIDER_NAME,
      kind: "invalid_output",
    });
  }

  return parseFlashcardsResponse(output, PROVIDER_NAME);
}
