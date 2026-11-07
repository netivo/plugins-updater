#!/usr/bin/env bash
# ==============================================================================
# Netivo Plugin Repository - Metadata Publisher
#
# Pushes plugin release metadata to Cloudflare R2 and purges Cloudflare Edge CDN.
#
# Required Environment Variables:
#   R2_ENDPOINT               Endpoint URL (e.g. https://<account_id>.r2.cloudflarestorage.com)
#   AWS_ACCESS_KEY_ID         Cloudflare R2 Access Key ID
#   AWS_SECRET_ACCESS_KEY     Cloudflare R2 Secret Access Key
#   R2_BUCKET                 Target R2 bucket name (e.g. netivo-wp-updates)
#
# Optional Environment Variables:
#   CF_ZONE_ID               Cloudflare Zone ID (required for CDN cache purge)
#   CF_API_TOKEN             Cloudflare API Token (required for CDN cache purge)
#   REPO_BASE_URL            Base public URL (default: https://updates.netivo.pl)
# ==============================================================================

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --slug <slug>                 Plugin slug (required, e.g. netivo-action-logger-mu)
  --name <name>                 Plugin human name (required, e.g. 'Netivo Action Logger (MU)')
  --type <type>                 Plugin type (mu-plugin|standard-plugin|dropin|theme, default: mu-plugin)
  --version <version>           Release version string without 'v' (required, e.g. 0.7.0)
  --tag <tag>                   Git tag (default: v<version>)
  --zip-path <path>             Local path to built release zip file (for sha256 checksum)
  --sha256 <hash>               Precomputed SHA256 hash (used if --zip-path is not provided)
  --download-url <url>          Public download URL for release zip
  --checksum-url <url>          Optional public URL for .sha256 file
  --requires-php <php_ver>      Minimum PHP version (default: 8.2)
  --requires-wp <wp_ver>        Minimum WordPress version (default: 6.3)
  --tested-wp <wp_ver>          Tested up to WordPress version (default: 6.7)
  --changelog <text>            Changelog summary for this release
  --description <text>          Plugin description for global index.json
  --help                        Show this message
EOF
  exit 1
}

# Defaults
SLUG=""
NAME=""
TYPE="mu-plugin"
VERSION=""
TAG=""
ZIP_PATH=""
SHA256=""
DOWNLOAD_URL=""
CHECKSUM_URL=""
REQUIRES_PHP="8.2"
REQUIRES_WP="6.3"
TESTED_WP="6.7"
CHANGELOG=""
DESCRIPTION=""
REPO_BASE_URL="${REPO_BASE_URL:-https://updates.netivo.pl}"
AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
export AWS_DEFAULT_REGION

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --type) TYPE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --zip-path) ZIP_PATH="$2"; shift 2 ;;
    --sha256) SHA256="$2"; shift 2 ;;
    --download-url) DOWNLOAD_URL="$2"; shift 2 ;;
    --checksum-url) CHECKSUM_URL="$2"; shift 2 ;;
    --requires-php) REQUIRES_PHP="$2"; shift 2 ;;
    --requires-wp) REQUIRES_WP="$2"; shift 2 ;;
    --tested-wp) TESTED_WP="$2"; shift 2 ;;
    --changelog) CHANGELOG="$2"; shift 2 ;;
    --description) DESCRIPTION="$2"; shift 2 ;;
    --help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

# Validate required variables
if [[ -z "$SLUG" || -z "$NAME" || -z "$VERSION" ]]; then
  echo "Error: --slug, --name, and --version are required." >&2
  usage
fi

if [[ -z "${R2_ENDPOINT:-}" || -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" || -z "${R2_BUCKET:-}" ]]; then
  echo "Error: R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and R2_BUCKET environment variables must be set." >&2
  exit 1
fi

if [[ -z "$TAG" ]]; then
  TAG="v${VERSION}"
fi

if [[ -z "$SHA256" ]]; then
  if [[ -n "$ZIP_PATH" && -f "$ZIP_PATH" ]]; then
    SHA256=$(sha256sum "$ZIP_PATH" | awk '{print $1}')
  else
    echo "Error: Either --sha256 or an existing --zip-path must be specified." >&2
    exit 1
  fi
fi

if [[ -z "$DOWNLOAD_URL" ]]; then
  echo "Error: --download-url is required." >&2
  exit 1
fi

if [[ -z "$CHANGELOG" ]]; then
  CHANGELOG="Release ${TAG}"
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "==> Publishing metadata for ${NAME} (${SLUG}) version ${VERSION} (${TAG})"

# ------------------------------------------------------------------------------
# 1. Update /<slug>/info.json
# ------------------------------------------------------------------------------
INFO_KEY="${SLUG}/info.json"
CURRENT_INFO="${TEMP_DIR}/current_info.json"
NEW_INFO="${TEMP_DIR}/new_info.json"

echo "==> Fetching existing ${INFO_KEY} from R2..."
if aws s3 cp "s3://${R2_BUCKET}/${INFO_KEY}" "$CURRENT_INFO" --endpoint-url "${R2_ENDPOINT}" 2>/dev/null; then
  echo "    Found existing manifest."
else
  echo "    No existing manifest found. Initializing new manifest structure."
  cat <<EOF > "$CURRENT_INFO"
{
  "\$schema": "${REPO_BASE_URL}/schemas/plugin.v1.json",
  "slug": "${SLUG}",
  "name": "${NAME}",
  "type": "${TYPE}",
  "homepage": "https://netivo.pl",
  "latest": "",
  "updated_at": "",
  "versions": {}
}
EOF
fi

echo "==> Updating manifest with version ${VERSION}..."
jq \
  --arg v "$VERSION" \
  --arg tag "$TAG" \
  --arg now "$NOW" \
  --arg dl "$DOWNLOAD_URL" \
  --arg sha "$SHA256" \
  --arg sha_url "$CHECKSUM_URL" \
  --arg req_php "$REQUIRES_PHP" \
  --arg req_wp "$REQUIRES_WP" \
  --arg test_wp "$TESTED_WP" \
  --arg changelog "$CHANGELOG" \
  --arg name "$NAME" \
  --arg type "$TYPE" \
  '
  .name = $name |
  .type = $type |
  .latest = $v |
  .updated_at = $now |
  .versions[$v] = {
    version: $v,
    tag: $tag,
    released_at: $now,
    requires_php: $req_php,
    requires_wp: $req_wp,
    tested_wp: $test_wp,
    download_url: $dl,
    checksum: {
      type: "sha256",
      value: $sha,
      url: (if $sha_url != "" then $sha_url else null end)
    },
    changelog: $changelog
  }
  ' "$CURRENT_INFO" > "$NEW_INFO"

echo "==> Uploading updated ${INFO_KEY} to s3://${R2_BUCKET}/${INFO_KEY}..."
aws s3 cp "$NEW_INFO" "s3://${R2_BUCKET}/${INFO_KEY}" \
  --endpoint-url "${R2_ENDPOINT}" \
  --content-type "application/json" \
  --cache-control "public, max-age=300, stale-while-revalidate=86400"

# ------------------------------------------------------------------------------
# 2. Update /index.json (Global Catalog)
# ------------------------------------------------------------------------------
INDEX_KEY="index.json"
CURRENT_INDEX="${TEMP_DIR}/current_index.json"
NEW_INDEX="${TEMP_DIR}/new_index.json"

echo "==> Fetching existing ${INDEX_KEY} from R2..."
if aws s3 cp "s3://${R2_BUCKET}/${INDEX_KEY}" "$CURRENT_INDEX" --endpoint-url "${R2_ENDPOINT}" 2>/dev/null; then
  echo "    Found existing catalog."
else
  echo "    No existing catalog found. Initializing new catalog."
  cat <<EOF > "$CURRENT_INDEX"
{
  "\$schema": "${REPO_BASE_URL}/schemas/repository.v1.json",
  "name": "Netivo WordPress Plugin Repository",
  "homepage": "https://netivo.pl",
  "updated_at": "",
  "plugins": {}
}
EOF
fi

MANIFEST_URL="${REPO_BASE_URL}/${SLUG}/info.json"

echo "==> Updating catalog entry for ${SLUG}..."
jq \
  --arg slug "$SLUG" \
  --arg name "$NAME" \
  --arg type "$TYPE" \
  --arg v "$VERSION" \
  --arg tag "$TAG" \
  --arg now "$NOW" \
  --arg req_php "$REQUIRES_PHP" \
  --arg req_wp "$REQUIRES_WP" \
  --arg manifest "$MANIFEST_URL" \
  --arg desc "$DESCRIPTION" \
  '
  .updated_at = $now |
  .plugins[$slug] = {
    name: $name,
    type: $type,
    latest_version: $v,
    latest_tag: $tag,
    requires_php: $req_php,
    requires_wp: $req_wp,
    description: (if $desc != "" then $desc else (.plugins[$slug].description // "") end),
    manifest_url: $manifest,
    last_updated: $now
  }
  ' "$CURRENT_INDEX" > "$NEW_INDEX"

echo "==> Uploading updated ${INDEX_KEY} to s3://${R2_BUCKET}/${INDEX_KEY}..."
aws s3 cp "$NEW_INDEX" "s3://${R2_BUCKET}/${INDEX_KEY}" \
  --endpoint-url "${R2_ENDPOINT}" \
  --content-type "application/json" \
  --cache-control "public, max-age=300, stale-while-revalidate=86400"

# ------------------------------------------------------------------------------
# 3. Purge Cloudflare Edge CDN Cache
# ------------------------------------------------------------------------------
if [[ -n "${CF_ZONE_ID:-}" && -n "${CF_API_TOKEN:-}" ]]; then
  echo "==> Purging Cloudflare Edge Cache for updated files..."
  PURGE_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{
      \"files\": [
        \"${REPO_BASE_URL}/index.json\",
        \"${REPO_BASE_URL}/${SLUG}/info.json\"
      ]
    }")

  STATUS_CODE=$(echo "$PURGE_RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
  if [[ "$STATUS_CODE" == "200" ]]; then
    echo "    Cache purged successfully."
  else
    echo "    Warning: Cache purge returned HTTP ${STATUS_CODE}."
  fi
else
  echo "==> Skipping Cloudflare cache purge (CF_ZONE_ID or CF_API_TOKEN not set)."
fi

echo "==> Successfully published metadata for ${SLUG} v${VERSION}!"
