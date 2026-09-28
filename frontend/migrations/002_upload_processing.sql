ALTER TABLE organization_storage
    ADD COLUMN IF NOT EXISTS reserved_files BIGINT NOT NULL DEFAULT 0 CHECK (reserved_files >= 0);

ALTER TABLE file_objects
    ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (scan_status IN ('PENDING', 'CLEAN', 'INFECTED', 'ERROR', 'SKIPPED'));

ALTER TABLE media_assets
    ADD COLUMN IF NOT EXISTS file_id UUID REFERENCES file_objects(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE;

ALTER TABLE transcode_jobs
    ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    ADD COLUMN IF NOT EXISTS last_error TEXT,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS media_assets_file_id_idx ON media_assets (file_id);
CREATE INDEX IF NOT EXISTS transcode_jobs_retry_idx
    ON transcode_jobs (next_attempt_at) WHERE status = 'FAILED' AND dead_lettered_at IS NULL;

CREATE OR REPLACE FUNCTION initialize_organization_storage()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO organization_storage (organization_id)
    VALUES (NEW.id)
    ON CONFLICT (organization_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organization_storage_after_create ON organization;
CREATE TRIGGER organization_storage_after_create
AFTER INSERT ON organization
FOR EACH ROW EXECUTE FUNCTION initialize_organization_storage();

INSERT INTO organization_storage (organization_id)
SELECT id FROM organization
ON CONFLICT (organization_id) DO NOTHING;