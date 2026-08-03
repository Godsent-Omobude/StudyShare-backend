import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";

/**
 * Extract readable text from a PDF or DOCX file.
 * pdf-parse 1.1.4 is intentionally used here, so the PDF import
 * must remain: import pdf from "pdf-parse";
 */
export const extractText = async (filePath) => {
  try {
    if (!filePath) {
      throw new Error("No file path was provided.");
    }

    const extension = path.extname(filePath).toLowerCase();

    console.log("File being extracted:", filePath);
    console.log("Detected extension:", extension || "none");

    switch (extension) {
      case ".pdf": {
        const buffer = fs.readFileSync(filePath);
        const data = await pdf(buffer);

        if (!data.text || data.text.trim() === "") {
          throw new Error("No readable text found in the PDF.");
        }

        return data.text.trim();
      }

      case ".docx": {
        const result = await mammoth.extractRawText({
          path: filePath
        });

        if (!result.value || result.value.trim() === "") {
          throw new Error("No readable text found in the DOCX file.");
        }

        return result.value.trim();
      }

      default:
        throw new Error(
          `Unsupported file type: ${extension || "unknown"}. ` +
          "Flashcard generation currently supports PDF and DOCX files only."
        );
    }
  } catch (error) {
    throw new Error(`Failed to extract text: ${error.message}`);
  }
};
