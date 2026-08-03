import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

export default ai;

export const generateFlashcards = async (
  documentText,
  count,
  difficulty
) => {
  if (!documentText || documentText.trim() === "") {
    throw new Error("Document contains no readable text.");
  }

  const prompt = `
You are an expert medical tutor.

Generate exactly ${count} flashcards from the supplied document.

Difficulty: ${difficulty}

Rules:
- Use ONLY information contained in the supplied document.
- Do NOT invent or add outside facts.
- Match the selected difficulty level.
- The front must contain a question or important concept.
- The back must contain a concise and accurate answer or explanation.
- Avoid duplicate questions.
- Focus on understanding, important facts, mechanisms, definitions, relationships, and applications where appropriate.
- Return ONLY valid JSON.
- Do NOT use markdown.
- Do NOT include code fences.
- Do NOT include any text outside the JSON.

Return exactly this structure:

[
  {
    "front": "Question or Concept",
    "back": "Answer or Explanation"
  }
]

DOCUMENT:

${documentText}
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt
    });

    const output = response.text?.trim();

    if (!output) {
      throw new Error("Gemini returned an empty response.");
    }

    // Remove accidental markdown code fences if Gemini adds them.
    const cleanedOutput = output
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const flashcards = JSON.parse(cleanedOutput);

    if (!Array.isArray(flashcards)) {
      throw new Error("Gemini returned an invalid flashcard format.");
    }

    return flashcards;

  } catch (error) {
    console.error("Gemini flashcard generation error:", error);

    throw new Error(
      error?.message || "Unable to generate flashcards."
    );
  }
};