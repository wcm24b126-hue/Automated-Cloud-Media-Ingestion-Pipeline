CREATE TYPE job_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE IF NOT EXISTS media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_filename VARCHAR(255) NOT NULL,
    raw_s3_key VARCHAR(512) NOT NULL,
    duration_seconds NUMERIC(10, 2),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcode_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES media_assets(id) ON DELETE CASCADE,
    resolution VARCHAR(32) NOT NULL,
    hls_playlist_s3_key VARCHAR(512),
    status job_status DEFAULT 'PENDING',
    error_message TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
