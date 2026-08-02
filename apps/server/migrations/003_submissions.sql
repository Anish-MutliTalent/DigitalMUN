-- ─── Migration 003: resolutions / directives submissions ──────────────────────
-- Delegates submit a resolution or directive as an uploaded file (PDF/DOC) or a
-- Google Doc link. The chair reviews them in real time, replacing email/SMS.
CREATE TABLE IF NOT EXISTS submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id  UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  delegate_id   UUID NOT NULL REFERENCES delegates(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('resolution','directive')),
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('file','link')),
  file_name     TEXT NULL,
  storage_path  TEXT NULL,
  mime          TEXT NULL,
  url           TEXT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','reviewed')),
  submitted_at  BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint)),
  reviewed_at   BIGINT NULL,
  reviewed_by   UUID NULL REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS submissions_committee_idx ON submissions(committee_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS submissions_delegate_idx ON submissions(delegate_id);
