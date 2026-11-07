#!/usr/bin/env node
/**
 * Netivo Plugin Repository - Cross-Platform R2 Seeder using Wrangler
 *
 * Seeds Cloudflare R2 bucket directly using Wrangler without needing AWS CLI.
 * Requires: npx wrangler login (or CLOUDFLARE_API_TOKEN).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BUCKET = process.env.R2_BUCKET || 'netivo-wp-updates';
const ROOT_DIR = path.resolve(__dirname, '..');

const filesToUpload = [
  // Schemas
  {
    local: path.join(ROOT_DIR, 'schemas', 'repository.v1.json'),
    r2Key: 'schemas/repository.v1.json',
    cacheControl: 'public, max-age=86400',
  },
  {
    local: path.join(ROOT_DIR, 'schemas', 'plugin.v1.json'),
    r2Key: 'schemas/plugin.v1.json',
    cacheControl: 'public, max-age=86400',
  },
  // Global catalog
  {
    local: path.join(ROOT_DIR, 'catalog', 'index.json'),
    r2Key: 'index.json',
    cacheControl: 'public, max-age=300, stale-while-revalidate=86400',
  },
  // Plugin manifests
  {
    local: path.join(ROOT_DIR, 'catalog', 'netivo-action-logger-mu', 'info.json'),
    r2Key: 'netivo-action-logger-mu/info.json',
    cacheControl: 'public, max-age=300, stale-while-revalidate=86400',
  },
];

console.log(`==> Seeding files to Cloudflare R2 bucket: "${BUCKET}" using Wrangler...\n`);

// 1. Ensure the bucket exists (create it if missing)
try {
  console.log(`--> Checking/creating R2 bucket "${BUCKET}"...`);
  execSync(`npx wrangler r2 bucket create "${BUCKET}"`, { stdio: 'pipe', cwd: ROOT_DIR });
  console.log(`    [OK] Bucket "${BUCKET}" created successfully.\n`);
} catch (err) {
  // If the bucket already exists or cannot be created, proceed to upload
  console.log(`    [INFO] Bucket ready.\n`);
}

let uploaded = 0;
let failed = 0;

for (const item of filesToUpload) {
  if (!fs.existsSync(item.local)) {
    console.warn(`[SKIP] File not found: ${item.local}`);
    continue;
  }

  const destination = `${BUCKET}/${item.r2Key}`;
  console.log(`--> Uploading ${item.r2Key}...`);

  const cmd = `npx wrangler r2 object put "${destination}" --file="${item.local}" --content-type="application/json" --cache-control="${item.cacheControl}" --remote`;

  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT_DIR });
    uploaded++;
    console.log(`    [OK] Uploaded to ${destination}\n`);
  } catch (err) {
    console.error(`    [FAIL] Failed uploading ${item.r2Key}: ${err.message}\n`);
    failed++;
  }
}

console.log(`==================================================`);
console.log(`Summary: ${uploaded} uploaded, ${failed} failed.`);
console.log(`==================================================`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
