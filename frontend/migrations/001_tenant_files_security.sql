CREATE TABLE IF NOT EXISTS file_objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    object_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 524288000),
    checksum_sha256 TEXT,
    upload_id TEXT,
    status TEXT NOT NULL DEFAULT 'UPLOADING'
        CHECK (status IN ('UPLOADING', 'QUARANTINED', 'SCANNING', 'AVAILABLE', 'REJECTED', 'FAILED')),
    visibility TEXT NOT NULL DEFAULT 'organization'
        CHECK (visibility IN ('private', 'organization')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS file_objects_org_created_idx
    ON file_objects (organization_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS file_objects_org_status_idx
    ON file_objects (organization_id, status);
CREATE INDEX IF NOT EXISTS file_objects_owner_idx
    ON file_objects (organization_id, owner_user_id);

CREATE TABLE IF NOT EXISTS organization_storage (
    organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
    quota_bytes BIGINT NOT NULL DEFAULT 5368709120 CHECK (quota_bytes > 0),
    max_file_bytes BIGINT NOT NULL DEFAULT 524288000 CHECK (max_file_bytes > 0),
    used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    file_count BIGINT NOT NULL DEFAULT 0 CHECK (file_count >= 0),
    max_files BIGINT NOT NULL DEFAULT 10000 CHECK (max_files > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS file_permissions (
    file_id UUID NOT NULL REFERENCES file_objects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    granted_by TEXT NOT NULL REFERENCES "user"(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_ip INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_events_org_created_idx ON audit_events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
    rate_key TEXT PRIMARY KEY,
    window_started_at TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count > 0)
);

CREATE TABLE IF NOT EXISTS malware_scan_results (
    file_id UUID PRIMARY KEY REFERENCES file_objects(id) ON DELETE CASCADE,
    scanner TEXT NOT NULL,
    scanner_version TEXT,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLEAN', 'INFECTED', 'ERROR')),
    signature TEXT,
    scanned_at TIMESTAMPTZ,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS file_processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID NOT NULL REFERENCES file_objects(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'RETRY', 'DEAD_LETTER')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
    last_error TEXT,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (file_id, job_type)
);
CREATE INDEX IF NOT EXISTS file_processing_jobs_ready_idx
    ON file_processing_jobs (available_at) WHERE status IN ('PENDING', 'RETRY');

CREATE TABLE IF NOT EXISTS app_schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);