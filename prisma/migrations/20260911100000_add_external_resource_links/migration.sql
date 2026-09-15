-- Adds support for cataloguing external academic resources (links to
-- material already hosted elsewhere, e.g. a Nigerian university's own
-- site) alongside Study2Gate's existing uploaded files, on the same
-- File table/model.
--
-- Backward compatible by construction:
--   * sourceType defaults to 'UPLOAD', so every existing row is
--     automatically and correctly classified as an uploaded file with no
--     backfill needed.
--   * externalUrl / externalDomain are new, nullable columns — existing
--     rows simply leave them null.
--   * filename / filepath / mimetype are relaxed to nullable so an
--     EXTERNAL_LINK row (which has no file) can omit them. Every existing
--     row already has these populated, so this is a pure relaxation and
--     changes nothing for existing data.

ALTER TABLE "File" ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'UPLOAD';
ALTER TABLE "File" ADD COLUMN "externalUrl" TEXT;
ALTER TABLE "File" ADD COLUMN "externalDomain" TEXT;

ALTER TABLE "File" ALTER COLUMN "filename" DROP NOT NULL;
ALTER TABLE "File" ALTER COLUMN "filepath" DROP NOT NULL;
ALTER TABLE "File" ALTER COLUMN "mimetype" DROP NOT NULL;

CREATE INDEX "File_sourceType_idx" ON "File"("sourceType");
