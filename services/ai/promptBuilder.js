// Kept in one place so Gemini, Groq, and OpenRouter are all asked for
// the same thing in the same way — output format/quality shouldn't
// depend on which provider ends up serving a given chunk.
export function buildFlashcardPrompt(documentText, count, difficulty) {
  return `
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
}
