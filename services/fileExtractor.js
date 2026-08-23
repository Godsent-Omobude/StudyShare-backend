import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";

/**
 * Return how many pages a PDF has, without extracting full text.
 * Uses max:1 so pdf-parse only renders the first page's text content,
 * while data.numpages still reflects the document's true total page count.
 */
export const getPdfPageCount = async (filePath) => {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer, { max: 1 });
  return data.numpages;
};

/**
 * Extract text from only a range of pages (1-indexed, inclusive) of a PDF.
 * Falls back to the whole document when no range is given.
 */
const extractPdfText = async (filePath, startPage, endPage) => {
  const buffer = fs.readFileSync(filePath);

  const options = {};

  if (endPage) {
    // pdf-parse only renders pages up to `max`, so we don't waste time
    // parsing pages after the requested range.
    options.max = endPage;
  }

  if (startPage && startPage > 1) {
    options.pagerender = (pageData) => {
      if (pageData.pageIndex + 1 < startPage) {
        return Promise.resolve("");
      }

      // This mirrors pdf-parse's default page renderer, just scoped to
      // the requested range.
      const renderOptions = {
        normalizeWhitespace: false,
        disableCombineTextItems: false
      };

      return pageData.getTextContent(renderOptions).then((textContent) => {
        let text = "";
        for (const item of textContent.items) {
          text += item.str + " ";
        }
        return text;
      });
    };
  }

  const data = await pdf(buffer, options);
  return { text: data.text, totalPages: data.numpages };
};

/**
 * Extract readable text from a PDF or DOCX file.
 * pdf-parse 1.1.4 is intentionally used here, so the PDF import
 * must remain: import pdf from "pdf-parse";
 *
 * For PDFs, an optional 1-indexed { startPage, endPage } range restricts
 * extraction to those pages. DOCX files are unaffected by page range and
 * always use the existing full-document extraction.
 */
export const extractText = async (filePath, pageRange = {}) => {
  try {
    if (!filePath) {
      throw new Error("No file path was provided.");
    }

    const extension = path.extname(filePath).toLowerCase();
    const { startPage, endPage } = pageRange;

    console.log("File being extracted:", filePath);
    console.log("Detected extension:", extension || "none");

    switch (extension) {
      case ".pdf": {
        const { text, totalPages } = await extractPdfText(
          filePath,
          startPage,
          endPage
        );

        if (startPage || endPage) {
          if (startPage < 1) {
            throw new Error("Start page cannot be less than 1.");
          }
          if (endPage > totalPages) {
            throw new Error(
              `Invalid page range. This PDF has ${totalPages} pages. Please select pages 1–${totalPages}.`
            );
          }
          if (startPage > endPage) {
            throw new Error("Start page cannot be greater than end page.");
          }
        }

        if (!text || text.trim() === "") {
          throw new Error("No readable text found in the selected PDF pages.");
        }

        return text.trim();
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
