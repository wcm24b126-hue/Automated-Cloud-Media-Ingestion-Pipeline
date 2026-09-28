#!/bin/bash
set -euo pipefail

echo ">>> Initializing LocalStack buckets..."

for bucket in raw-videos processed-media; do
  if ! awslocal s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    awslocal s3 mb "s3://$bucket"
  fi
done

echo ">>> LocalStack buckets ready."