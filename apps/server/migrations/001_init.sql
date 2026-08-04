-- ─── MUN Guardian — initial schema ────────────────────────────────────────────
-- Migration 001_init.sql
--
-- Conventions:
--   * Primary keys are UUID v4 (gen_random_uuid()).
--   * Timestamps are BIGINT milliseconds since the Unix epoch (UTC), matching
--     the wire protocol in @mun/protocol. This avoids timestamptz conversion
--     bugs and keeps server/client in sync.
--   * Append-only tables (audit_log, vote_records) have triggers that forbid
--     UPDATE and DELETE so immutability is enforced at the database layer, not
--     just in application code.
--   * The audit_log is a hash chain; `seq` is an identity column that gives a
--     monotonic, gap-free sequence.
-- ──────────────────────────────────────────────────────────────────────────────

-- ─── users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('delegate','chair','admin')),
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint))
);

CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);

-- ─── sessions ─────────────────────────────────────────────────────────────────
-- One row per authenticated session. Single-device enforcement: a delegate may
-- have at most one row with revoked=false. Crashes do NOT auto-revoke (rows
-- persist until explicit logout/revocation/chair-approved re-login).
CREATE TABLE IF NOT EXISTS sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('delegate','chair','admin')),
  device_id          TEXT NOT NULL,
  platform           TEXT NOT NULL CHECK (platform IN ('windows','macos')),
  client_version     TEXT NOT NULL DEFAULT '0.0.0',
  access_token_hash  TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  refresh_jti        TEXT NOT NULL,
  created_at         BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint)),
  expires_at         BIGINT NOT NULL,
  last_seen_at       BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint)),
  revoked            BOOLEAN NOT NULL DEFAULT false,
  revoke_reason      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_access_token_hash_uniq ON sessions(access_token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_token_hash_uniq ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS sessions_active_user_idx ON sessions(user_id) WHERE revoked = false;
CREATE INDEX IF NOT EXISTS sessions_refresh_jti_idx ON sessions(refresh_jti);

-- ─── committees ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS committees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  topic         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','break','emergency_stopped')),
  chair_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at    BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint)),
  rev           BIGINT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS committees_status_idx ON committees(status);
CREATE INDEX IF NOT EXISTS committees_chair_idx ON committees(chair_user_id);

-- ─── delegates ────────────────────────────────────────────────────────────────
-- One delegation per user (unique user_id). The delegate's Ed25519 voting
-- public key is registered here; the private key never leaves the device.
CREATE TABLE IF NOT EXISTS delegates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  committee_id       UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  country            TEXT NOT NULL,
  attendance         TEXT NOT NULL DEFAULT 'not_checked_in' CHECK (attendance IN ('not_checked_in','present','voting','absent')),
  connection_status  TEXT NOT NULL DEFAULT 'never_connected' CHECK (connection_status IN ('never_connected','connected','disconnected','reconnecting')),
  last_heartbeat_at  BIGINT NULL,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  disabled_reason    TEXT NULL,
  public_key         TEXT NULL,
  created_at         BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint))
);

ALTER TABLE delegates ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

CREATE INDEX IF NOT EXISTS delegates_committee_idx ON delegates(committee_id);
CREATE INDEX IF NOT EXISTS delegates_enabled_idx ON delegates(committee_id) WHERE enabled = true;

-- ─── AI detection rules ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_detection_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('windows','macos','all')),
  match_field  TEXT NOT NULL CHECK (match_field IN ('app','title','app_or_title')),
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('contains','equals','regex')),
  pattern      TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  severity     TEXT NOT NULL DEFAULT 'critical' CHECK (severity IN ('info','warning','critical')),
  category     TEXT NOT NULL DEFAULT 'ai_assistant',
  created_at   BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint)),
  updated_at   BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint))
);

CREATE INDEX IF NOT EXISTS ai_rules_enabled_idx ON ai_detection_rules(enabled);

-- ─── monitoring events ────────────────────────────────────────────────────────
-- Append-only-ish (we never edit; idempotency via (delegate_id, client_event_id)).
CREATE TABLE IF NOT EXISTS monitoring_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_event_id   UUID NOT NULL,
  delegate_id       UUID NOT NULL REFERENCES delegates(id) ON DELETE CASCADE,
  committee_id      UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('focus_change','away','return','ai_detected','unexpected_app','idle','session_start','session_end')),
  server_ts         BIGINT NOT NULL,
  client_ts         BIGINT NOT NULL,
  app_name          TEXT NULL,
  title             TEXT NULL,
  title_scope       TEXT NOT NULL DEFAULT 'none' CHECK (title_scope IN ('none','app_only','matched','self')),
  matched_rule_id   UUID NULL REFERENCES ai_detection_rules(id) ON DELETE SET NULL,
  matched_rule_name TEXT NULL,
  severity          TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  duration_ms       BIGINT NULL,
  from_app_name     TEXT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS monitoring_events_dedup_uniq ON monitoring_events(delegate_id, client_event_id);
CREATE INDEX IF NOT EXISTS monitoring_events_committee_ts_idx ON monitoring_events(committee_id, server_ts DESC);
CREATE INDEX IF NOT EXISTS monitoring_events_delegate_ts_idx ON monitoring_events(delegate_id, server_ts DESC);
CREATE INDEX IF NOT EXISTS monitoring_events_type_ts_idx ON monitoring_events(type, server_ts DESC);

-- ─── warnings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warnings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id    UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  delegate_id     UUID NOT NULL REFERENCES delegates(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('ai_detected','unexpected_app','away','disconnected','relogin_request','duplicate_login_attempt')),
  severity        TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  message         TEXT NOT NULL,
  rule_id         UUID NULL REFERENCES ai_detection_rules(id) ON DELETE SET NULL,
  app_name        TEXT NULL,
  timestamp       BIGINT NOT NULL,
  acknowledged    BOOLEAN NOT NULL DEFAULT false,
  acknowledged_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at BIGINT NULL
);

CREATE INDEX IF NOT EXISTS warnings_committee_ts_idx ON warnings(committee_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS warnings_delegate_idx ON warnings(delegate_id);
CREATE INDEX IF NOT EXISTS warnings_unack_idx ON warnings(committee_id) WHERE acknowledged = false;

-- ─── votes ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS votes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id   UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','revealed')),
  created_by     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint)),
  closed_at      BIGINT NULL,
  revealed_at    BIGINT NULL,
  required_count INTEGER NOT NULL DEFAULT 0,
  submitted_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS votes_committee_status_idx ON votes(committee_id, status);
CREATE INDEX IF NOT EXISTS votes_status_idx ON votes(status);

-- ─── vote records (immutable) ─────────────────────────────────────────────────
-- One row per (vote, delegate). UNIQUE constraints prevent duplicate votes and
-- idempotent re-casts. A trigger forbids UPDATE/DELETE (immutability).
CREATE TABLE IF NOT EXISTS vote_records (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id        UUID NOT NULL REFERENCES votes(id) ON DELETE RESTRICT,
  delegate_id    UUID NOT NULL REFERENCES delegates(id) ON DELETE RESTRICT,
  choice         TEXT NOT NULL CHECK (choice IN ('for','against')),
  signature      TEXT NOT NULL,
  public_key     TEXT NOT NULL,
  client_cast_id UUID NOT NULL,
  submitted_at   BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint)),
  receipt        TEXT NOT NULL,
  recorded_hash  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS vote_records_vote_delegate_uniq ON vote_records(vote_id, delegate_id);
CREATE UNIQUE INDEX IF NOT EXISTS vote_records_client_cast_uniq ON vote_records(vote_id, client_cast_id);
CREATE INDEX IF NOT EXISTS vote_records_vote_idx ON vote_records(vote_id);

-- Block mutation of vote_records.
CREATE OR REPLACE FUNCTION mun_vote_records_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'vote_records is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vote_records_no_update ON vote_records;
CREATE TRIGGER vote_records_no_update
  BEFORE UPDATE ON vote_records
  FOR EACH ROW EXECUTE FUNCTION mun_vote_records_immutable();

DROP TRIGGER IF EXISTS vote_records_no_delete ON vote_records;
CREATE TRIGGER vote_records_no_delete
  BEFORE DELETE ON vote_records
  FOR EACH ROW EXECUTE FUNCTION mun_vote_records_immutable();

-- ─── scheduled breaks ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_breaks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  start_at     BIGINT NOT NULL,
  end_at       BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','ended','cancelled')),
  created_at   BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint))
);

CREATE INDEX IF NOT EXISTS breaks_committee_idx ON scheduled_breaks(committee_id);
CREATE INDEX IF NOT EXISTS breaks_status_idx ON scheduled_breaks(status, start_at);

-- ─── relogin requests ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relogin_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delegate_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegate_id    UUID NOT NULL REFERENCES delegates(id) ON DELETE CASCADE,
  committee_id   UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  reason         TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')),
  requested_at   BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint)),
  decided_by     UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at     BIGINT NULL,
  decision_reason TEXT NULL
);

CREATE INDEX IF NOT EXISTS relogin_status_idx ON relogin_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS relogin_committee_idx ON relogin_requests(committee_id);
CREATE UNIQUE INDEX IF NOT EXISTS relogin_pending_uniq ON relogin_requests(delegate_user_id) WHERE status = 'pending';

-- ─── audit log (hash-chained, append-only) ────────────────────────────────────
-- `seq` is an identity column providing a monotonic sequence. prev_hash/hash
-- form the tamper-evident chain. Triggers forbid UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS audit_log (
  seq        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp  BIGINT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  subject    TEXT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action);

CREATE OR REPLACE FUNCTION mun_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_no_update ON audit_log;
CREATE TRIGGER audit_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION mun_audit_immutable();

DROP TRIGGER IF EXISTS audit_no_delete ON audit_log;
CREATE TRIGGER audit_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION mun_audit_immutable();

-- ─── server config (key/value) ────────────────────────────────────────────────
-- Holds the server Ed25519 receipt-signing keypair and other runtime config.
-- Access to this table must be restricted to the application DB role.
CREATE TABLE IF NOT EXISTS server_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint))
);

-- ─── migrations tracking ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _migrations (
  id         TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint))
);
