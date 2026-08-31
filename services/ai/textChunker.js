import { estimateTokens, MAX_CHUNKS } from "./tokenManager.js";

// Light, safe cleanup before a document is ever sent to an AI provider.
// Deliberately conservative: this trims noise, it does not summarise or
// otherwise remove academic content.
export function cleanText(text) {
  if (!text) return "";

  return (
    text
      // Normalise Windows/old-Mac line endings so blank-line collapsing
      // below works consistently regardless of the source document.
      .replace(/\r\n?/g, "\n")
      // Trim trailing whitespace on each line.
      .replace(/[ \t]+$/gm, "")
      // Collapse runs of 3+ blank lines down to a single paragraph break.
      .replace(/\n{3,}/g, "\n\n")
      // Collapse repeated spaces/tabs (common PDF-extraction artifact)
      // without touching newlines, which carry paragraph structure.
      .replace(/[ \t]{2,}/g, " ")
      // Drop a line that's an exact repeat of the line immediately before
      // it — a common PDF-extraction artifact (running headers/footers
      // repeated verbatim) — without touching legitimate repeated content
      // that isn't back-to-back.
      .split("\n")
      .filter((line, i, all) => i === 0 || line.trim() === "" || line !== all[i - 1])
      .join("\n")
      .trim()
  );
}

function splitIntoParagraphs(text) {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Splits on sentence-ending punctuation followed by whitespace and a
// capital/number (a reasonable heuristic for prose; not perfect, but this
// only needs to avoid cutting mid-sentence, not achieve NLP-grade accuracy).
function splitIntoSentences(paragraph) {
  const sentences = paragraph.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/);
  return sentences.length ? sentences : [paragraph];
}

// Last-resort split for a single sentence/paragraph that alone exceeds the
// chunk budget (e.g. a huge run-on line with no punctuation). Splits on
// whitespace so it never cuts a word in half.
function splitByWords(text, maxTokens) {
  const words = text.split(/\s+/);
  const pieces = [];
  let current = [];
  let currentTokens = 0;

  for (const word of words) {
    const wordTokens = estimateTokens(word + " ");
    if (currentTokens + wordTokens > maxTokens && current.length) {
      pieces.push(current.join(" "));
      current = [];
      currentTokens = 0;
    }
    current.push(word);
    currentTokens += wordTokens;
  }
  if (current.length) pieces.push(current.join(" "));
  return pieces;
}

function takeOverlapTail(text, overlapTokens) {
  if (!overlapTokens || !text) return "";
  const approxChars = overlapTokens * 4;
  if (text.length <= approxChars) return text;
  const tail = text.slice(-approxChars);
  // Prefer starting the overlap at a sentence boundary rather than
  // mid-sentence, when one exists reasonably close by.
  const sentenceStart = tail.search(/[.!?]\s+[A-Z0-9"']/);
  if (sentenceStart > -1 && sentenceStart < tail.length * 0.6) {
    return tail.slice(sentenceStart + 1).trim();
  }
  // Otherwise fall back to a word boundary.
  const spaceIdx = tail.indexOf(" ");
  return (spaceIdx > -1 ? tail.slice(spaceIdx + 1) : tail).trim();
}

// Splits cleaned text into token-aware chunks, preferring paragraph and
// sentence boundaries over arbitrary character cuts, with a small overlap
// carried into the start of each chunk after the first so context isn't
// lost entirely across a boundary.
//
// Returns a single-element array (the whole text, unmodified) when the
// text already fits within maxTokens — chunking only kicks in when needed.
export function chunkText(text, { maxTokens, overlapTokens = 0 } = {}) {
  if (!text) return [];
  if (estimateTokens(text) <= maxTokens) return [text];

  const paragraphs = splitIntoParagraphs(text);
  const chunks = [];
  let current = "";
  let currentTokens = 0;

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
    currentTokens = 0;
  };

  const seedWithOverlap = () => {
    if (!chunks.length) return;
    const tail = takeOverlapTail(chunks[chunks.length - 1], overlapTokens);
    if (tail) {
      current = tail;
      currentTokens = estimateTokens(tail);
    }
  };

  const addUnit = (unit, unitTokens) => {
    if (currentTokens + unitTokens > maxTokens && current) {
      flush();
      seedWithOverlap();
    }
    current += (current ? "\n\n" : "") + unit;
    currentTokens += unitTokens;
  };

  for (const paragraph of paragraphs) {
    if (chunks.length >= MAX_CHUNKS) break;

    const paragraphTokens = estimateTokens(paragraph);

    if (paragraphTokens > maxTokens) {
      // This single paragraph alone exceeds the budget — fall back to
      // sentence-level splitting (and word-level, if even one sentence
      // is still too big) rather than cutting it arbitrarily.
      flush();
      for (const sentence of splitIntoSentences(paragraph)) {
        const sentenceTokens = estimateTokens(sentence);
        if (sentenceTokens > maxTokens) {
          for (const piece of splitByWords(sentence, maxTokens)) {
            addUnit(piece, estimateTokens(piece));
          }
        } else {
          addUnit(sentence, sentenceTokens);
        }
      }
      continue;
    }

    addUnit(paragraph, paragraphTokens);
  }

  flush();

  if (chunks.length > MAX_CHUNKS) {
    console.warn(
      `[AI] Document produced ${chunks.length} chunks, exceeding MAX_CHUNKS=${MAX_CHUNKS}; truncating to the first ${MAX_CHUNKS}.`
    );
    return chunks.slice(0, MAX_CHUNKS);
  }

  return chunks;
}

// Splits a requested flashcard count roughly evenly across chunks, with
// any remainder going to the earliest chunks (so counts stay within 1 of
// each other rather than being lopsided).
export function distributeCount(count, chunkCount) {
  if (chunkCount <= 1) return [count];

  const base = Math.floor(count / chunkCount);
  const remainder = count % chunkCount;

  return Array.from({ length: chunkCount }, (_, i) => base + (i < remainder ? 1 : 0));
}
