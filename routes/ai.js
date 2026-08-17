import express from "express";
import { protect } from "../middleware/auth.js";
import upload from "../middleware/upload.js";

import {
  createFlashcards,
  getMyFlashcards,
  getFlashcardSet,
  deleteFlashcardSet,
  evaluateFlashcardAnswer,
  savePracticeResult
} from "../controllers/flashcardsController.js";

const router = express.Router();

// Generate flashcards from a PDF or DOCX document.
// The frontend must send the file using the field name: "document".
router.post(
  "/flashcards",
  protect,
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
