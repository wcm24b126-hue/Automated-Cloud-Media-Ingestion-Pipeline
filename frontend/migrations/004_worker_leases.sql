ALTER TABLE file_processing_jobs
    ADD COLUMN IF NOT EXISTS locked_by TEXT;

CREATE INDEX IF NOT EXISTS file_processing_jobs_expired_lease_idx
    ON file_processing_jobs (updated_at)
    WHERE status = 'PROCESSING';

ALTER TABLE malware_scan_results
    DROP CONSTRAINT IF EXISTS malware_scan_results_status_check;

ALTER TABLE malware_scan_results
    ADD CONSTRAINT malware_scan_results_status_check
    CHECK (status IN ('PENDING', 'CLEAN', 'INFECTED', 'ERROR', 'SKIPPED'));