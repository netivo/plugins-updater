#!/usr/bin/env bash
# ==============================================================================
# Netivo Plugin Repository - Initial R2 Seeder
#
# Seeds Cloudflare R2 bucket with schemas/ and catalog/ contents.
#
# Required Environment Variables:
#   R2_ENDPOINT               Endpoint URL (https://<account_id>.r2.cloudflarestorage.com)
#   AWS_ACCESS_KEY_ID         Cloudflare R2 Access Key ID
#   AWS_SECRET_ACCESS_KEY     Cloudflare R2 Secret Access Key
#   R2_BUCKET                 Target R2 bucket name (e.g. netivo-wp-updates)
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -z "${R2_ENDPOINT:-}" || -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" || -z "${R2_BUCKET:-}" ]]; then
  echo "Error: R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and R2_BUCKET environment variables must be set." >&2
  exit 1
fi

export AWS_DEFAULT_REGION="auto"

echo "==> Seeding schemas to s3://${R2_BUCKET}/schemas/..."
aws s3 sync "${ROOT_DIR}/schemas" "s3://${R2_BUCKET}/schemas" \
  --endpoint-url "${R2_ENDPOINT}" \
  --content-type "application/json" \
  --cache-control "public, max-age=86400"

echo "==> Seeding catalog to s3://${R2_BUCKET}/..."
aws s3 sync "${ROOT_DIR}/catalog" "s3://${R2_BUCKET}" \
  --endpoint-url "${R2_ENDPOINT}" \
  --content-type "application/json" \
  --cache-control "public, max-age=300, stale-while-revalidate=86400"

echo "==> Seeding completed successfully!"
