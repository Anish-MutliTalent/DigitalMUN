-- Add disabled_reason column to delegates table.
-- Stores the chair's decree comment shown to the delegate when disabled.
ALTER TABLE delegates ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
