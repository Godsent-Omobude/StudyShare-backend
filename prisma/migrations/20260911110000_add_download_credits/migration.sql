-- Adds the download-credit balance backing the Download Credit System.
--
-- Every user earns +2 credits per successfully uploaded document (see
-- routes/files.js POST /upload) and spends 1 credit per successful
-- download (see routes/files.js GET /download/:id). The balance lives on
-- the User row so it is enforced by the backend/database rather than any
-- client-side state, persists across devices/sessions, and is always
-- mutated with an atomic conditional update to prevent it from ever going
-- negative under concurrent requests.
--
-- Defaults to 0 for every existing row — no retroactive credits are
-- granted for uploads that happened before this feature existed.

ALTER TABLE "User" ADD COLUMN "downloadCredits" INTEGER NOT NULL DEFAULT 0;
