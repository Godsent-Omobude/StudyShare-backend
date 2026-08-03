import fs from "fs/promises";
import prisma from "../config/prisma.js";
import { extractText } from "../services/fileExtractor.js";
import { generateFlashcards } from "../services/flashcardGenerator.js";

export const getMyFlashcards = async (req, res) => {
  try {
    const flashcardSets = await prisma.flashcardSet.findMany({
      where: {
        userId: req.user.id
      },
      include: {
        flashcards: true
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    return res.status(200).json({
      success: true,
      flashcardSets
    });
  } catch (error) {
    console.error("Get flashcards error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

export const getFlashcardSet = async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid flashcard set ID."
      });
    }

    const flashcardSet = await prisma.flashcardSet.findFirst({
      where: {
        id,
        userId: req.user.id
      },
      include: {
        flashcards: true
      }
    });

    if (!flashcardSet) {
      return res.status(404).json({
        success: false,
        message: "Flashcard set not found."
      });
    }

    return res.status(200).json({
      success: true,
      flashcardSet
    });
  } catch (error) {
    console.error("Get flashcard set error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

export const deleteFlashcardSet = async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid flashcard set ID."
      });
    }

    const flashcardSet = await prisma.flashcardSet.findFirst({
      where: {
        id,
        userId: req.user.id
      }
    });

    if (!flashcardSet) {
      return res.status(404).json({
        success: false,
        message: "Flashcard set not found."
      });
    }

    await prisma.flashcardSet.delete({
      where: {
        id
      }
    });

    return res.status(200).json({
      success: true,
      message: "Flashcard set deleted successfully."
    });
  } catch (error) {
    console.error("Delete flashcard set error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

export const createFlashcards = async (req, res) => {
  let uploadedFilePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a PDF or DOCX document."
      });
    }

    uploadedFilePath = req.file.path;

    const {
      title,
      count = 20,
      difficulty = "medium"
    } = req.body;

    const flashcardCount = Number(count);

    if (
      !Number.isInteger(flashcardCount) ||
      flashcardCount < 5 ||
      flashcardCount > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Flashcard count must be an integer between 5 and 100."
      });
    }

    const normalizedDifficulty = String(difficulty).toLowerCase();
    const allowedDifficulties = ["easy", "medium", "hard"];

    if (!allowedDifficulties.includes(normalizedDifficulty)) {
      return res.status(400).json({
        success: false,
        message: "Invalid difficulty. Choose easy, medium, or hard."
      });
    }

    const documentText = await extractText(uploadedFilePath);

    const generatedFlashcards = await generateFlashcards(
      documentText,
      flashcardCount,
      normalizedDifficulty
    );

    if (!generatedFlashcards.length) {
      throw new Error("No flashcards were generated.");
    }

    const flashcardSet = await prisma.flashcardSet.create({
      data: {
        title: title?.trim() || req.file.originalname,
        difficulty: normalizedDifficulty,
        userId: req.user.id,
        flashcards: {
          create: generatedFlashcards.map((card) => ({
            front: card.front,
            back: card.back
          }))
        }
      },
      include: {
        flashcards: true
      }
    });

    return res.status(201).json({
      success: true,
      message: "Flashcards generated successfully.",
      flashcardSet
    });
  } catch (error) {
    console.error("Create flashcards error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to generate flashcards."
    });
  } finally {
    // The uploaded source document is temporary; the generated cards are stored in Prisma.
    if (uploadedFilePath) {
      try {
        await fs.unlink(uploadedFilePath);
      } catch (cleanupError) {
        console.warn("Could not remove temporary AI upload:", cleanupError.message);
      }
    }
  }
};
