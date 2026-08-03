import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

if (!process.env.GEMINI_API_KEY) {
  console.warn("Warning: GEMINI_API_KEY is not set.");
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

export default ai;
