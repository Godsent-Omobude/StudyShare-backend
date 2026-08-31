function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordSet(text) {
  return new Set(normalize(text).split(" ").filter(Boolean));
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}

// Removes exact and near-duplicate flashcards (front-text similarity),
// keeping the first (highest-priority-chunk) occurrence of each. Purely
// local/deterministic — no extra AI call, so it doesn't add token usage.
const NEAR_DUPLICATE_THRESHOLD = 0.8;

export function dedupeFlashcards(cards) {
  const kept = [];
  const keptWordSets = [];

  for (const card of cards) {
    const norm = normalize(card.front);
    if (!norm) continue;

    const words = wordSet(card.front);
    const isDuplicate = keptWordSets.some((existing) => jaccardSimilarity(words, existing) >= NEAR_DUPLICATE_THRESHOLD);

    if (!isDuplicate) {
      kept.push(card);
      keptWordSets.push(words);
    }
  }

  return kept;
}
