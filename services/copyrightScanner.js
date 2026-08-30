import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import prisma from "../config/prisma.js";
import { extractText } from "./fileExtractor.js";

export const COPYRIGHT_CONFIRMATION_VERSION = "2026-08-29";

const MAX_TEXT_FOR_SEARCH = 12000;
const PHRASES_TO_SEARCH = 3;

const normalizeText = (text) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim();

const sha256File = async (filePath) => {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
};

const cleanSearchPhrase = (phrase) =>
  normalizeText(phrase)
    .replace(/["“”‘’]/g, "")
    .replace(/[^\p{L}\p{N}\s.,;:!?()'/-]/gu, "")
    .trim()
    .slice(0, 180);

const getDistinctPhrases = (text) => {
  const cleaned = normalizeText(text);
  if (!cleaned) return [];

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map(cleanSearchPhrase)
    .filter((s) => s.length >= 70 && s.length <= 180);

  const phrases = [];
  const seen = new Set();

  for (const sentence of sentences) {
    const key = sentence.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      phrases.push(sentence);
    }
    if (phrases.length >= PHRASES_TO_SEARCH) break;
  }

  if (!phrases.length) {
    const words = cleaned.split(/\s+/);
    for (
      let i = 0;
      i + 20 <= words.length && phrases.length < PHRASES_TO_SEARCH;
      i += 40
    ) {
      const phrase = cleanSearchPhrase(words.slice(i, i + 30).join(" "));
      if (phrase.length >= 70) phrases.push(phrase);
    }
  }

  return phrases;
};

const searchWeb = async (phrase) => {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const searchEngineId = process.env.GOOGLE_CSE_ID;

  if (!apiKey || !searchEngineId) {
    return { configured: false, items: [] };
  }

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", searchEngineId);
  url.searchParams.set("q", `"${phrase}"`);
  url.searchParams.set("num", "5");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Web search returned HTTP ${response.status}.`);
  }

  const data = await response.json();

  return {
    configured: true,
    items: (data.items || []).map((item) => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet,
      phrase,
    })),
  };
};

const calculateRisk = ({ text, webMatches, exactDuplicate }) => {
  if (exactDuplicate) {
    return {
      score: 100,
      status: "BLOCKED",
      reasons: ["An identical file has already been uploaded to Study2Gate."],
    };
  }

  let score = 0;
  const reasons = [];
  const lower = text.toLowerCase();

  const copyrightMarkers = [
    "all rights reserved",
    "copyright ©",
    "copyright (c)",
    "isbn",
    "published by",
    "publisher:",
  ];

  const markerCount = copyrightMarkers.filter((marker) =>
    lower.includes(marker)
  ).length;

  if (markerCount >= 1) {
    score += 20;
    reasons.push("The document contains copyright/publication indicators.");
  }
  if (markerCount >= 3) score += 20;

  const uniquePhrases = new Set(
    webMatches.map((match) => String(match.phrase || "").toLowerCase()).filter(Boolean)
  );
  const uniqueDomains = new Set(
    webMatches
      .map((match) => {
        try {
          return new URL(match.link).hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  if (uniquePhrases.size) {
    // Repeated hits for different distinctive phrases are stronger evidence
    // than several result pages for the same phrase.
    score += Math.min(
      60,
      uniquePhrases.size * 20 + Math.min(2, uniqueDomains.size) * 10
    );
    reasons.push(
      "Distinctive text from the upload produced potential matches in publicly indexed online sources."
    );
  }

  let status = "APPROVED";
  if (score >= 60) status = "BLOCKED";
  else if (score >= 35) status = "REVIEW";

  return { score, status, reasons };
};

export const scanCopyright = async ({ filePath, originalName }) => {
  const contentHash = await sha256File(filePath);

  const duplicate = await prisma.file.findFirst({
    where: { contentHash },
    select: { id: true, title: true },
  });

  let text = "";
  const extension = path.extname(originalName || filePath).toLowerCase();

  if ([".pdf", ".docx"].includes(extension)) {
    try {
      text = normalizeText(await extractText(filePath));
      text = text.slice(0, MAX_TEXT_FOR_SEARCH);
    } catch (error) {
      // Scanned/image-only PDFs may have no extractable text. The exact-file
      // hash check still runs, so such uploads are not silently unprotected.
      console.warn("Copyright text extraction skipped:", error.message);
    }
  }

  const phrases = getDistinctPhrases(text);
  const webSearchConfigured = Boolean(
    process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_ID
  );
  const webMatches = [];

  if (webSearchConfigured) {
    for (const phrase of phrases) {
      try {
        const result = await searchWeb(phrase);
        webMatches.push(...result.items);
      } catch (error) {
        // A temporary search-provider failure must not turn into a false
        // copyright claim. The upload can still be evaluated by the local
        // fingerprint/metadata checks.
        console.warn("Copyright web search failed:", error.message);
        break;
      }
    }
  }

  const risk = calculateRisk({
    text,
    webMatches,
    exactDuplicate: Boolean(duplicate),
  });

  return {
    confirmationVersion: COPYRIGHT_CONFIRMATION_VERSION,
    contentHash,
    duplicate,
    status: risk.status,
    riskScore: risk.score,
    reasons: risk.reasons,
    webSearchConfigured,
    webMatchCount: webMatches.length,
    textWasExtracted: Boolean(text),
  };
};
