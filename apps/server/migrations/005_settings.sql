-- System settings table for global configuration toggles
CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint))
);

INSERT INTO system_settings (key, value) VALUES ('allow_file_uploads', 'true') ON CONFLICT DO NOTHING;
