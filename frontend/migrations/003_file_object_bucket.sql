ALTER TABLE file_objects
    ADD COLUMN IF NOT EXISTS object_bucket TEXT NOT NULL DEFAULT 'raw-videos';

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_file_id_unique_idx
    ON media_assets (file_id) WHERE file_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS transcode_jobs_asset_resolution_unique_idx
    ON transcode_jobs (asset_id, resolution) WHERE asset_id IS NOT NULL;