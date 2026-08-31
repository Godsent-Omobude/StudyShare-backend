import ai from "../config/gemini.js";
import { generateFlashcards as generateFlashcardsWithFallback } from "./ai/aiProviderManager.js";

// Kept as the default export: controllers/flashcardsController.js still
// imports this directly for evaluateFlashcardAnswer's Gemini-based fuzzy
// grading, which is unrelated to flashcard generation and intentionally
// untouched. Previously this file created its own separate GoogleGenAI
// instance; it now reuses the one already exported by config/gemini.js
// (same behaviour, one fewer duplicate client).
export default ai;

// Public interface is unchanged: same signature, same return shape
// (array of { front, back }), same thrown-Error-on-failure contract.
// Internally this now runs document chunking (for large documents) and
// tries Gemini, then Groq, then OpenRouter as needed — see
// services/ai/aiProviderManager.js for the orchestration and
// services/ai/*Provider.js for each provider's implementation.
export const generateFlashcards = async (documentText, count, difficulty) => {
  return generateFlashcardsWithFallback(documentText, count, difficulty);
};
