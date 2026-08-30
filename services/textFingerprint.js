// Lightweight, dependency-free near-duplicate detection.
//
// We never store a document's extracted text. Instead we reduce it to a
// small MinHash signature (an array of integers) that lets us *estimate*
// Jaccard similarity against other documents' signatures without ever
// comparing raw text again. This keeps storage tiny (a few dozen ints per
// file) and keeps document contents out of logs/DB entirely.
//
// How it works:
//   1. Normalise + split the text into overlapping word "shingles"
//      (k consecutive words). Two documents that share a lot of the same
//      shingles are very likely near-duplicates of each other.
//   2. For each of N independent hash functions, keep only the minimum
//      hash value seen across all shingles ("MinHash"). The probability
//      that two documents agree on a given MinHash slot is a provable
//      estimator of their true Jaccard similarity.
//   3. Comparing two signatures is just: count matching slots / N.
//
// This is intentionally simple (no external ML/NLP dependency) and is
// good enough to flag "this is basically the same lecture notes again",
// not to make a legal determination — see COPYRIGHT_SCREENING.md.

const SHINGLE_SIZE = 8; // words per shingle
const NUM_HASHES = 32; // signature length

// 32 pairs of odd multipliers/additive constants for cheap universal
// hashing (a*x + b) mod PRIME. Fixed/deterministic so signatures generated
// today remain comparable to ones generated tomorrow.
const PRIME = 4294967311; // first prime > 2^32
const HASH_SEEDS = Array.from({ length: NUM_HASHES }, (_, i) => ({
  a: 2 * i + 1,
  b: (i + 1) * 104729, // 10000th prime, arbitrary but fixed
}));

const normalize = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// FNV-1a — fast, deterministic, good-enough distribution for this purpose.
const fnv1a = (str) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const getShingles = (normalizedText) => {
  const words = normalizedText.split(" ").filter(Boolean);
  if (words.length < SHINGLE_SIZE) {
    return words.length ? [words.join(" ")] : [];
  }

  const shingles = new Set();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i += 1) {
    shingles.add(words.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return Array.from(shingles);
};

/**
 * Produces a fixed-length MinHash signature for a block of text.
 * Returns an empty array if there isn't enough text to fingerprint
 * (e.g. a scanned/image-only PDF with no extractable text).
 */
export const computeFingerprint = (text) => {
  const shingles = getShingles(normalize(text));
  if (!shingles.length) return [];

  const baseHashes = shingles.map(fnv1a);

  return HASH_SEEDS.map(({ a, b }) => {
    let min = Infinity;
    for (const h of baseHashes) {
      const v = (a * h + b) % PRIME;
      if (v < min) min = v;
    }
    return min;
  });
};

/**
 * Estimated Jaccard similarity (0..1) between two MinHash signatures.
 */
export const compareFingerprints = (sigA, sigB) => {
  if (!sigA?.length || !sigB?.length || sigA.length !== sigB.length) return 0;

  let matches = 0;
  for (let i = 0; i < sigA.length; i += 1) {
    if (sigA[i] === sigB[i]) matches += 1;
  }
  return matches / sigA.length;
};

/**
 * Finds the closest near-duplicate among a set of candidate files.
 * candidates: [{ id, title, textFingerprint }]
 */
export const findClosestMatch = (signature, candidates) => {
  let best = null;

  for (const candidate of candidates) {
    if (!candidate.textFingerprint?.length) continue;
    const score = compareFingerprints(signature, candidate.textFingerprint);
    if (!best || score > best.similarityScore) {
      best = { id: candidate.id, title: candidate.title, similarityScore: score };
    }
  }

  return best;
};
