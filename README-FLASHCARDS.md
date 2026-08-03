# StudyShare Backend — Flashcard Generation Update

This version fixes the PDF/DOCX flashcard upload flow and connects the saved flashcard endpoints.

## Important frontend requirement

For flashcard generation, send the uploaded file in FormData using the field name:

`document`

Other fields accepted:

- `title` — optional
- `count` — integer from 5 to 100
- `difficulty` — `easy`, `medium`, or `hard`

Endpoint:

`POST /api/ai/flashcards`

The request must include the logged-in user's Bearer token.

## Saved flashcards endpoints

- `GET /api/ai/flashcards`
- `GET /api/ai/flashcards/:id`
- `DELETE /api/ai/flashcards/:id`

## Environment

Copy `.env.example` to `.env` and provide your real values.

Never commit `.env` or your Gemini API key to GitHub.

## Dependencies

No new npm package is required by this update. The existing `multer`, `pdf-parse@1.1.4`, `mammoth`, Prisma and `@google/genai` dependencies are used.

## Local setup

```bash
npm install
npx prisma generate
npx prisma db push
npm run dev
```
