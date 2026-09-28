package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type queuedFile struct {
	ID             string
	OrganizationID string
	OwnerUserID    string
	OriginalName   string
	MimeType       string
	ObjectBucket   string
	ObjectKey      string
	SizeBytes      int64
	Status         string
	ScanStatus     string
}

type processingJob struct {
	ID          string
	FileID      string
	JobType     string
	Attempts    int
	MaxAttempts int
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	production := os.Getenv("APP_ENV") == "production"
	endpoint := os.Getenv("R2_ENDPOINT")
	if endpoint == "" {
		endpoint = os.Getenv("LOCALSTACK_ENDPOINT")
	}
	if endpoint == "" {
		endpoint = "http://localhost:4566"
	}
	if production && (os.Getenv("R2_ENDPOINT") == "" || os.Getenv("R2_ACCESS_KEY_ID") == "" || os.Getenv("R2_SECRET_ACCESS_KEY") == "") {
		log.Fatal("R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required in production")
	}

	accessKey := os.Getenv("R2_ACCESS_KEY_ID")
	secretKey := os.Getenv("R2_SECRET_ACCESS_KEY")
	if accessKey == "" {
		accessKey = os.Getenv("AWS_ACCESS_KEY_ID")
	}
	if secretKey == "" {
		secretKey = os.Getenv("AWS_SECRET_ACCESS_KEY")
	}
	if accessKey == "" && !production {
		accessKey = "test"
	}
	if secretKey == "" && !production {
		secretKey = "test"
	}
	region := os.Getenv("R2_REGION")
	if region == "" {
		region = os.Getenv("AWS_DEFAULT_REGION")
	}
	if region == "" {
		region = "ap-south-1"
		if production {
			region = "auto"
		}
	}

	customResolver := aws.EndpointResolverWithOptionsFunc(
		func(service, _ string, _ ...interface{}) (aws.Endpoint, error) {
			return aws.Endpoint{URL: endpoint, HostnameImmutable: true}, nil
		},
	)
	awsConfig, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(region),
		config.WithEndpointResolverWithOptions(customResolver),
		config.WithCredentialsProvider(aws.CredentialsProviderFunc(
			func(context.Context) (aws.Credentials, error) {
				return aws.Credentials{AccessKeyID: accessKey, SecretAccessKey: secretKey}, nil
			},
		)),
	)
	if err != nil {
		log.Fatalf("AWS config error: %v", err)
	}
	s3Client := s3.NewFromConfig(awsConfig)

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" && production {
		log.Fatal("DATABASE_URL is required in production")
	}
	if dbURL == "" {
		dbURL = "postgres://pipeline_user:pipeline_secure_pass@localhost:5432/mediadb"
	}
	db, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("PostgreSQL connection error: %v", err)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		log.Fatalf("PostgreSQL ping failed: %v", err)
	}

	processedBucket := os.Getenv("PROCESSED_BUCKET")
	if processedBucket == "" && !production {
		processedBucket = "processed-media"
	}
	if production && processedBucket == "" {
		log.Fatal("PROCESSED_BUCKET is required in production")
	}
	workerID, _ := os.Hostname()
	workerID = fmt.Sprintf("%s-%d", workerID, os.Getpid())
	log.Printf("[Worker ready] Polling database jobs as %s", workerID)

	for ctx.Err() == nil {
		job, err := claimNextJob(ctx, db, workerID)
		if errors.Is(err, pgx.ErrNoRows) {
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second):
			}
			continue
		}
		if err != nil {
			log.Printf("Could not claim processing job: %v", err)
			select {
			case <-ctx.Done():
			case <-time.After(3 * time.Second):
			}
			continue
		}

		jobErr := runProcessingJob(ctx, db, s3Client, *job, processedBucket)
		if err := finishProcessingJob(ctx, db, *job, jobErr); err != nil {
			log.Printf("Could not finalize processing job %s: %v", job.ID, err)
		}
	}
	log.Println("Worker shutting down")
}

func claimNextJob(ctx context.Context, db *pgxpool.Pool, workerID string) (*processingJob, error) {
	job := &processingJob{}
	err := db.QueryRow(ctx,
		`WITH candidate AS (
			SELECT id FROM file_processing_jobs
			WHERE (status IN ('PENDING', 'RETRY') AND available_at <= NOW())
			   OR (status = 'PROCESSING' AND updated_at < NOW() - INTERVAL '2 hours')
			ORDER BY available_at, created_at
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		UPDATE file_processing_jobs job
		SET status = 'PROCESSING', attempts = job.attempts + 1,
		    locked_by = $1, updated_at = NOW()
		FROM candidate
		WHERE job.id = candidate.id
		RETURNING job.id, job.file_id, job.job_type, job.attempts, job.max_attempts`,
		workerID,
	).Scan(&job.ID, &job.FileID, &job.JobType, &job.Attempts, &job.MaxAttempts)
	if err != nil {
		return nil, err
	}
	return job, nil
}

func runProcessingJob(ctx context.Context, db *pgxpool.Pool, s3Client *s3.Client, job processingJob, processedBucket string) error {
	file, err := loadFile(ctx, db, job.FileID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}

	switch job.JobType {
	case "malware_scan":
		return runMalwareScan(ctx, db, s3Client, file)
	case "video_transcode":
		if file.Status != "AVAILABLE" || (file.ScanStatus != "CLEAN" && file.ScanStatus != "SKIPPED") {
			return errors.New("video is not available until malware scanning succeeds")
		}
		workDir, err := os.MkdirTemp("", "media-transcode-*")
		if err != nil {
			return fmt.Errorf("create transcode directory: %w", err)
		}
		defer os.RemoveAll(workDir)
		input := filepath.Join(workDir, "source")
		if err := downloadObject(ctx, s3Client, file.ObjectBucket, file.ObjectKey, input, file.SizeBytes); err != nil {
			return err
		}
		return transcodeVideo(ctx, s3Client, db, file, input, workDir, processedBucket)
	default:
		return fmt.Errorf("unknown processing job type %q", job.JobType)
	}
}

func loadFile(ctx context.Context, db *pgxpool.Pool, fileID string) (queuedFile, error) {
	var file queuedFile
	err := db.QueryRow(ctx,
		`SELECT id, organization_id, owner_user_id, original_name, mime_type, object_bucket,
		        object_key, size_bytes, status, scan_status
		 FROM file_objects WHERE id = $1`, fileID,
	).Scan(&file.ID, &file.OrganizationID, &file.OwnerUserID, &file.OriginalName,
		&file.MimeType, &file.ObjectBucket, &file.ObjectKey, &file.SizeBytes, &file.Status, &file.ScanStatus)
	return file, err
}

func runMalwareScan(ctx context.Context, db *pgxpool.Pool, s3Client *s3.Client, file queuedFile) error {
	if file.Status == "REJECTED" || file.ScanStatus == "INFECTED" {
		return nil
	}
	if file.SizeBytes <= 0 || file.SizeBytes > 500*1024*1024 {
		return rejectFile(ctx, db, file, "File size is outside the allowed range")
	}
	if file.ScanStatus == "CLEAN" || file.ScanStatus == "SKIPPED" {
		return enqueueVideoTranscode(ctx, db, file)
	}

	workDir, err := os.MkdirTemp("", "media-scan-*")
	if err != nil {
		return fmt.Errorf("create scan directory: %w", err)
	}
	defer os.RemoveAll(workDir)
	input := filepath.Join(workDir, "source")
	if err := downloadObject(ctx, s3Client, file.ObjectBucket, file.ObjectKey, input, file.SizeBytes); err != nil {
		return err
	}
	if _, err := db.Exec(ctx, "UPDATE file_objects SET status = 'SCANNING', updated_at = NOW() WHERE id = $1", file.ID); err != nil {
		return fmt.Errorf("mark file scanning: %w", err)
	}

	scanStatus, scanErr := scanWithClamAV(ctx, input)
	if errors.Is(scanErr, errMalwareDetected) {
		return rejectFile(ctx, db, file, "Malware detected")
	}
	if scanErr != nil {
		_, _ = db.Exec(ctx,
			`INSERT INTO malware_scan_results (file_id, scanner, status, details)
			 VALUES ($1, 'clamav', 'ERROR', jsonb_build_object('error', $2))
			 ON CONFLICT (file_id) DO UPDATE SET status = 'ERROR', details = EXCLUDED.details`,
			file.ID, scanErr.Error())
		return scanErr
	}

	_, err = db.Exec(ctx,
		`UPDATE file_objects SET scan_status = $2, status = 'AVAILABLE', updated_at = NOW() WHERE id = $1`,
		file.ID, scanStatus)
	if err != nil {
		return fmt.Errorf("mark file scan result: %w", err)
	}
	scanner := "clamav"
	if scanStatus == "SKIPPED" {
		scanner = "local-development-skip"
	}
	_, err = db.Exec(ctx,
		`INSERT INTO malware_scan_results (file_id, scanner, status, scanned_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (file_id) DO UPDATE SET scanner = EXCLUDED.scanner,
		   status = EXCLUDED.status, scanned_at = NOW(), details = '{}'::jsonb`,
		file.ID, scanner, scanStatus)
	if err != nil {
		return fmt.Errorf("record scan result: %w", err)
	}
	return enqueueVideoTranscode(ctx, db, file)
}

func enqueueVideoTranscode(ctx context.Context, db *pgxpool.Pool, file queuedFile) error {
	if !strings.HasPrefix(strings.ToLower(file.MimeType), "video/") {
		return nil
	}
	_, err := db.Exec(ctx,
		`INSERT INTO file_processing_jobs (file_id, job_type, status)
		 VALUES ($1, 'video_transcode', 'PENDING')
		 ON CONFLICT (file_id, job_type) DO UPDATE SET
		   status = CASE WHEN file_processing_jobs.status = 'COMPLETED' THEN 'COMPLETED' ELSE 'PENDING' END,
		   available_at = LEAST(file_processing_jobs.available_at, NOW()), updated_at = NOW()`,
		file.ID)
	return err
}

func finishProcessingJob(ctx context.Context, db *pgxpool.Pool, job processingJob, processingError error) error {
	if processingError == nil {
		_, err := db.Exec(ctx,
			`UPDATE file_processing_jobs SET status = 'COMPLETED', locked_by = NULL, last_error = NULL,
			 updated_at = NOW() WHERE id = $1`, job.ID)
		return err
	}
	status := "RETRY"
	delay := time.Duration(5*math.Pow(2, float64(min(job.Attempts-1, 8)))) * time.Second
	if job.Attempts >= job.MaxAttempts {
		status = "DEAD_LETTER"
		delay = 24 * time.Hour
	}
	_, err := db.Exec(ctx,
		`UPDATE file_processing_jobs SET status = $2, locked_by = NULL, last_error = $3,
		 available_at = NOW() + $4 * INTERVAL '1 second', updated_at = NOW() WHERE id = $1`,
		job.ID, status, processingError.Error(), int64(delay.Seconds()))
	if err == nil {
		log.Printf("Job %s failed (attempt %d/%d), status=%s: %v", job.ID, job.Attempts, job.MaxAttempts, status, processingError)
	}
	return err
}

func downloadObject(ctx context.Context, s3Client *s3.Client, bucket, key, destination string, expectedSize int64) error {
	resp, err := s3Client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		return fmt.Errorf("download s3://%s/%s: %w", bucket, key, err)
	}
	defer resp.Body.Close()
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("create source file: %w", err)
	}
	written, copyErr := io.Copy(file, io.LimitReader(resp.Body, 500*1024*1024+1))
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("download source file: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close source file: %w", closeErr)
	}
	if written != expectedSize || written > 500*1024*1024 {
		return fmt.Errorf("source size mismatch: expected %d bytes, received %d", expectedSize, written)
	}
	return nil
}

func rejectFile(ctx context.Context, db *pgxpool.Pool, file queuedFile, reason string) error {
	client, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer client.Rollback(ctx)
	if _, err := client.Exec(ctx,
		`UPDATE file_objects SET status = 'REJECTED', scan_status = 'INFECTED', updated_at = NOW() WHERE id = $1`, file.ID); err != nil {
		return fmt.Errorf("reject file: %w", err)
	}
	if _, err := client.Exec(ctx,
		`INSERT INTO malware_scan_results (file_id, scanner, status, scanned_at, details)
		 VALUES ($1, 'clamav', 'INFECTED', NOW(), jsonb_build_object('reason', $2))
		 ON CONFLICT (file_id) DO UPDATE SET status = 'INFECTED', scanned_at = NOW(), details = EXCLUDED.details`,
		file.ID, reason); err != nil {
		return fmt.Errorf("record infected file: %w", err)
	}
	if _, err := client.Exec(ctx,
		`UPDATE organization_storage SET used_bytes = GREATEST(0, used_bytes - $2),
		 file_count = GREATEST(0, file_count - 1), updated_at = NOW() WHERE organization_id = $1`,
		file.OrganizationID, file.SizeBytes); err != nil {
		return fmt.Errorf("release infected file quota: %w", err)
	}
	if _, err := client.Exec(ctx,
		`INSERT INTO audit_events (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
		 VALUES ($1, $2, 'file.rejected', 'file', $3, jsonb_build_object('reason', $4))`,
		file.OrganizationID, file.OwnerUserID, file.ID, reason); err != nil {
		return fmt.Errorf("audit infected file: %w", err)
	}
	return client.Commit(ctx)
}

func transcodeVideo(ctx context.Context, s3Client *s3.Client, db *pgxpool.Pool, file queuedFile, inputFile, workDir, processedBucket string) error {
	var assetID string
	err := db.QueryRow(ctx,
		`INSERT INTO media_assets (original_filename, raw_s3_key, file_id, organization_id)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (file_id) WHERE file_id IS NOT NULL
		 DO UPDATE SET raw_s3_key = EXCLUDED.raw_s3_key
		 RETURNING id`, file.OriginalName, file.ObjectKey, file.ID, file.OrganizationID).Scan(&assetID)
	if err != nil {
		return fmt.Errorf("create media asset: %w", err)
	}
	var jobID string
	err = db.QueryRow(ctx,
		`INSERT INTO transcode_jobs (asset_id, resolution, status)
		 VALUES ($1, '720p', 'PROCESSING')
		 ON CONFLICT (asset_id, resolution) WHERE asset_id IS NOT NULL
		 DO UPDATE SET status = 'PROCESSING', last_error = NULL, updated_at = NOW()
		 RETURNING id`, assetID).Scan(&jobID)
	if err != nil {
		return fmt.Errorf("create transcode job: %w", err)
	}

	outputM3U8 := filepath.Join(workDir, "stream.m3u8")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-i", inputFile, "-profile:v", "baseline", "-level", "3.0",
		"-s", "1280x720", "-start_number", "0", "-hls_time", "6", "-hls_list_size", "0", "-f", "hls", outputM3U8)
	if output, err := cmd.CombinedOutput(); err != nil {
		_, _ = db.Exec(ctx, "UPDATE transcode_jobs SET status = 'FAILED', attempts = attempts + 1, last_error = $2, error_message = $2, updated_at = NOW() WHERE id = $1", jobID, string(output))
		return fmt.Errorf("ffmpeg transcode: %w", err)
	}

	segments, err := filepath.Glob(filepath.Join(workDir, "*"))
	if err != nil {
		return fmt.Errorf("list HLS outputs: %w", err)
	}
	playlistKey := fmt.Sprintf("hls/%s/stream.m3u8", assetID)
	for _, segment := range segments {
		extension := filepath.Ext(segment)
		if extension != ".m3u8" && extension != ".ts" {
			continue
		}
		data, err := os.Open(segment)
		if err != nil {
			return fmt.Errorf("open HLS output: %w", err)
		}
		targetKey := fmt.Sprintf("hls/%s/%s", assetID, filepath.Base(segment))
		contentType := "video/mp2t"
		if extension == ".m3u8" {
			contentType = "application/vnd.apple.mpegurl"
		}
		_, uploadErr := s3Client.PutObject(ctx, &s3.PutObjectInput{
			Bucket: aws.String(processedBucket), Key: aws.String(targetKey), Body: data,
			ContentType: aws.String(contentType),
		})
		closeErr := data.Close()
		if uploadErr != nil {
			return fmt.Errorf("upload HLS segment: %w", uploadErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close HLS segment: %w", closeErr)
		}
	}
	if _, err := db.Exec(ctx,
		`UPDATE transcode_jobs SET status = 'COMPLETED', hls_playlist_s3_key = $2,
		 error_message = NULL, last_error = NULL, updated_at = NOW() WHERE id = $1`, jobID, playlistKey); err != nil {
		return fmt.Errorf("complete transcode job: %w", err)
	}
	log.Printf("Transcode completed for asset %s", assetID)
	return nil
}
