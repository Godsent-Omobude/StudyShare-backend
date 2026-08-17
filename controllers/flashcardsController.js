import fs from "fs/promises";
import prisma from "../config/prisma.js";
import { extractText } from "../services/fileExtractor.js";
import { generateFlashcards, default as ai } from "../services/flashcardGenerator.js";

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


export const savePracticeResult = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const score = Number(req.body.score);
    const completedCount = Number(req.body.completedCount);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid flashcard set ID."
      });
    }

    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return res.status(400).json({
        success: false,
        message: "Practice score must be between 0 and 100."
      });
    }

    if (!Number.isInteger(completedCount) || completedCount < 1) {
      return res.status(400).json({
        success: false,
        message: "At least one flashcard must be completed."
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

    const savedSet = await prisma.flashcardSet.update({
      where: { id },
      data: {
        lastPracticeScore: Math.round(score),
        lastPracticeCount: completedCount,
        lastPracticedAt: new Date()
      }
    });

    return res.status(200).json({
      success: true,
      message: "Practice result saved successfully.",
      practiceResult: {
        score: savedSet.lastPracticeScore,
        completedCount: savedSet.lastPracticeCount,
        practicedAt: savedSet.lastPracticedAt
      }
    });
  } catch (error) {
    console.error("Save practice result error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to save practice result."
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


export const evaluateFlashcardAnswer = async (req, res) => {
  try {
    const { question, expectedAnswer, userAnswer } = req.body;

    if (!question || !expectedAnswer || !userAnswer?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Question, expected answer, and your answer are required."
      });
    }

    const normalize = (value) =>
      String(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    const expected = normalize(expectedAnswer);
    const submitted = normalize(userAnswer);

    // Fast path for short factual answers. This avoids an unnecessary Gemini call.
    const expectedWords = expected.split(" ").filter(Boolean);
    const submittedWords = submitted.split(" ").filter(Boolean);

    if (
      expectedWords.length <= 6 &&
      submittedWords.length <= 10 &&
      expected &&
      submitted
    ) {
      const exact = expected === submitted;
      const contains =
        expectedWords.length > 1 &&
        (submitted.includes(expected) || expected.includes(submitted));

      if (exact || contains) {
        return res.status(200).json({
          success: true,
          evaluation: {
            score: exact ? 100 : 90,
            verdict: exact ? "Correct" : "Mostly correct",
            feedback: exact
              ? "Your answer matches the expected answer."
              : "Your answer contains the expected answer or its key wording.",
            missedPoints: []
          }
        });
      }
    }

    const prompt = `
You are evaluating a student's answer to a study flashcard.

Question:
${question}

Expected answer:
${expectedAnswer}

Student answer:
${userAnswer}

Evaluate the student's answer against the expected answer.

Rules:
- Focus on correctness, completeness, and whether the key concepts are present.
- Do not require the exact wording of the expected answer.
- Give partial credit when the student demonstrates partial understanding.
- Do not reward statements that contradict the expected answer.
- Be concise and educational.
- Score from 0 to 100.
- Return ONLY valid JSON. No markdown and no code fences.

Return exactly:
{
  "score": 0,
  "verdict": "Correct | Mostly correct | Partially correct | Incorrect",
  "feedback": "Brief explanation of the score.",
  "missedPoints": ["Important point missed", "Another point missed"]
}
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt
    });

    const output = response.text?.trim();

    if (!output) {
      throw new Error("Gemini returned an empty evaluation.");
    }

    const cleanedOutput = output
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const evaluation = JSON.parse(cleanedOutput);
    const score = Math.max(
      0,
      Math.min(100, Number(evaluation.score) || 0)
    );

    return res.status(200).json({
      success: true,
      evaluation: {
        score,
        verdict: evaluation.verdict || "Evaluated",
        feedback:
          evaluation.feedback || "Your answer has been evaluated.",
        missedPoints: Array.isArray(evaluation.missedPoints)
          ? evaluation.missedPoints
          : []
      }
    });
  } catch (error) {
    console.error("Flashcard answer evaluation error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to evaluate your answer."
    });
  }
};
