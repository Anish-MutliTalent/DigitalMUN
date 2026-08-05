-- Migration 006_vice_chair.sql
-- Add vice chair / moderator role support

-- 1. Update the 'users' table role constraint
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('delegate','chair','admin','vice'));

-- 2. Update the 'sessions' table role constraint
ALTER TABLE sessions DROP CONSTRAINT sessions_role_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_role_check CHECK (role IN ('delegate','chair','admin','vice'));

-- 3. Add 'vice_user_id' to committees
ALTER TABLE committees ADD COLUMN vice_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS committees_vice_idx ON committees(vice_user_id);
