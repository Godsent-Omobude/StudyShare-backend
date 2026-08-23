import express from "express";
import { protect } from "../middleware/auth.js";
import upload from "../middleware/upload.js";
import { aiGenerationLimiter } from "../middleware/rateLimiter.js";

import {
  createFlashcards,
  getMyFlashcards,
  getFlashcardSet,
  deleteFlashcardSet,
  evaluateFlashcardAnswer,
  savePracticeResult,
  getDocumentInfo
} from "../controllers/flashcardsController.js";
import { getStreak, recordStudySession } from "../controllers/streakController.js";

const router = express.Router();

// Study streak: read the user's current/longest streak, and record a
// qualifying study session (min flashcard count enforced server-side).
router.get(
  "/streak",
  protect,
  getStreak
);

router.post(
  "/streak",
  protect,
  recordStudySession
);

// Inspect a document right after it's selected — for PDFs this returns the
// total page count so the frontend can show it and validate the page-range
// fields before generation is requested.
router.post(
  "/pdf-info",
  protect,
  upload.single("document"),
  getDocumentInfo
);

// Generate flashcards from a PDF or DOCX document.
// The frontend must send the file using the field name: "document".
// For PDFs, startPage/endPage (1-indexed, inclusive) may be included to
// restrict generation to a page range; omitting them uses the whole document.
router.post(
  "/flashcards",
  protect,
  aiGenerationLimiter.middleware,
  upload.single("document"),
  createFlashcards
);


// Evaluate a student's answer before the correct answer is revealed.
router.post(
  "/flashcards/evaluate",
  protect,
  evaluateFlashcardAnswer
);

// Get all flashcard sets belonging to the logged-in user.
router.get(
  "/flashcards",
  protect,
  getMyFlashcards
);


// Save the latest Test Yourself result for a flashcard set.
router.post(
  "/flashcards/:id/practice-result",
  protect,
  savePracticeResult
);

// Get one flashcard set belonging to the logged-in user.
router.get(
  "/flashcards/:id",
  protect,
  getFlashcardSet
);

// Delete one flashcard set belonging to the logged-in user.
router.delete(
  "/flashcards/:id",
  protect,
  deleteFlashcardSet
);

export default router;
