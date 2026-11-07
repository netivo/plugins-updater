#!/usr/bin/env node
/**
 * Netivo Plugin Repository - Cross-Platform Metadata Publisher
 *
 * Updates plugin release metadata in Cloudflare R2 and purges the CDN cache.
 * Designed to run on any runner (GitHub-hosted or self-hosted) using Node.js/pnpm.
 *
 * Supports multiple R2 backends:
 *   1. AWS CLI (if installed and configured)
 *   2. Wrangler (npx wrangler or pnpm exec wrangler)
 *
 * Environment variables:
 *   R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_BUCKET (for AWS CLI)
 *   CLOUDFLARE_API_TOKEN (for Wrangler or Cloudflare API cache purge)
 *   CF_ZONE_ID, CF_API_TOKEN (for Cloudflare CDN cache purge)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function parseArgs(args) {
  const params = {
    slug: '',
    name: '',
    type: 'mu-plugin',
    version: '',
    tag: '',
    zipPath: '',
    sha256: '',
    downloadUrl: '',
    checksumUrl: '',
    requiresPhp: '8.2',
    requiresWp: '6.3',
    testedWp: '6.7',
    changelog: '',
    description: '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--slug') { params.slug = next; i++; }
    else if (arg === '--name') { params.name = next; i++; }
    else if (arg === '--type') { params.type = next; i++; }
    else if (arg === '--version') { params.version = next; i++; }
    else if (arg === '--tag') { params.tag = next; i++; }
    else if (arg === '--zip-path' || arg === '--zip') { params.zipPath = next; i++; }
    else if (arg === '--sha256') { params.sha256 = next; i++; }
    else if (arg === '--download-url') { params.downloadUrl = next; i++; }
    else if (arg === '--checksum-url') { params.checksumUrl = next; i++; }
    else if (arg === '--requires-php') { params.requiresPhp = next; i++; }
    else if (arg === '--requires-wp') { params.requiresWp = next; i++; }
    else if (arg === '--tested-wp') { params.testedWp = next; i++; }
    else if (arg === '--changelog') { params.changelog = next; i++; }
    else if (arg === '--description') { params.description = next; i++; }
  }

  return params;
}

function computeSha256(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found for SHA-256 calculation: ${filePath}`);
  }
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hasCommand(cmd) {
  try {
    const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(checkCmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function downloadFromR2(bucket, key, localPath, r2Endpoint) {
  if (hasCommand('aws') && r2Endpoint && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      execSync(`aws s3 cp "s3://${bucket}/${key}" "${localPath}" --endpoint-url "${r2Endpoint}"`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  // Fallback: Wrangler
  try {
    execSync(`npx wrangler r2 object get "${bucket}/${key}" --file="${localPath}" --remote`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function uploadToR2(bucket, key, localPath, r2Endpoint, cacheControl) {
  if (hasCommand('aws') && r2Endpoint && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    execSync(
      `aws s3 cp "${localPath}" "s3://${bucket}/${key}" --endpoint-url "${r2Endpoint}" --content-type "application/json" --cache-control "${cacheControl}"`,
      { stdio: 'inherit' }
    );
    return;
  }

  // Fallback: Wrangler
  execSync(
    `npx wrangler r2 object put "${bucket}/${key}" --file="${localPath}" --content-type="application/json" --cache-control="${cacheControl}" --remote`,
    { stdio: 'inherit' }
  );
}

async function purgeCloudflareCache(zoneId, apiToken, files) {
  if (!zoneId || !apiToken) {
    console.log('[INFO] Cloudflare cache purge skipped (CF_ZONE_ID or CF_API_TOKEN not set).');
    return;
  }

  console.log(`--> Purging Cloudflare Edge cache for ${files.length} file(s)...`);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files }),
    });

    const data = await res.json();
    if (data.success) {
      console.log('    [OK] Cloudflare CDN cache purged successfully.');
    } else {
      console.warn('    [WARN] Cache purge failed:', JSON.stringify(data.errors));
    }
  } catch (err) {
    console.warn(`    [WARN] Cache purge request failed: ${err.message}`);
  }
}

async function main() {
  const params = parseArgs(process.argv.slice(2));

  if (!params.slug || !params.name || !params.version) {
    console.error('Error: --slug, --name, and --version are required.');
    process.exit(1);
  }

  if (!params.tag) {
    params.tag = `v${params.version}`;
  }

  if (!params.sha256) {
    if (params.zipPath) {
      params.sha256 = computeSha256(params.zipPath);
    } else {
      console.error('Error: Either --sha256 or --zip-path must be specified.');
      process.exit(1);
    }
  }

  if (!params.downloadUrl) {
    console.error('Error: --download-url is required.');
    process.exit(1);
  }

  const bucket = process.env.R2_BUCKET || process.env.R2_BUCKET_NAME || 'netivo-wp-updates';
  const r2Endpoint = process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  const repoBaseUrl = (process.env.REPO_BASE_URL || 'https://updates.netivo.dev').replace(/\/+$/, '');
  const zoneId = process.env.CF_ZONE_ID;
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;

  console.log(`=======================================================`);
  console.log(`Publishing release metadata for: ${params.name} (${params.slug})`);
  console.log(`Version: ${params.version} (${params.tag})`);
  console.log(`SHA-256: ${params.sha256}`);
  console.log(`Bucket:  ${bucket}`);
  console.log(`=======================================================\n`);

  const tmpDir = path.join(process.cwd(), '.tmp-publisher-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Manage <slug>/info.json
    const infoKey = `${params.slug}/info.json`;
    const localInfoPath = path.join(tmpDir, 'info.json');

    let manifest = {
      $schema: `${repoBaseUrl}/schemas/plugin.v1.json`,
      slug: params.slug,
      name: params.name,
      type: params.type,
      homepage: 'https://netivo.pl',
      latest: '',
      updated_at: '',
      versions: {},
    };

    console.log(`--> Fetching existing ${infoKey} from R2...`);
    if (downloadFromR2(bucket, infoKey, localInfoPath, r2Endpoint)) {
      try {
        const raw = fs.readFileSync(localInfoPath, 'utf8');
        manifest = JSON.parse(raw);
        console.log('    Found existing manifest.');
      } catch {
        console.log('    Existing file invalid, using fresh manifest template.');
      }
    } else {
      console.log('    No existing manifest found. Creating new manifest.');
    }

    const now = new Date().toISOString();
    manifest.name = params.name;
    manifest.type = params.type;
    manifest.latest = params.version;
    manifest.updated_at = now;
    manifest.versions = manifest.versions || {};

    manifest.versions[params.version] = {
      version: params.version,
      tag: params.tag,
      released_at: now,
      requires_php: params.requiresPhp,
      requires_wp: params.requiresWp,
      tested_wp: params.testedWp,
      download_url: params.downloadUrl,
      checksum: {
        type: 'sha256',
        value: params.sha256,
        url: params.checksumUrl || `${params.downloadUrl}.sha256`,
      },
      changelog: params.changelog || `Release ${params.tag}`,
    };

    fs.writeFileSync(localInfoPath, JSON.stringify(manifest, null, 2), 'utf8');

    console.log(`--> Uploading updated ${infoKey} to R2...`);
    uploadToR2(bucket, infoKey, localInfoPath, r2Endpoint, 'public, max-age=300, stale-while-revalidate=86400');
    console.log('    [OK] Uploaded ' + infoKey);

    // 2. Manage global index.json catalog
    const indexKey = 'index.json';
    const localIndexPath = path.join(tmpDir, 'index.json');

    let catalog = {
      $schema: `${repoBaseUrl}/schemas/repository.v1.json`,
      name: 'Netivo WordPress Plugin Repository',
      updated_at: '',
      plugins: {},
    };

    console.log(`--> Fetching global ${indexKey} from R2...`);
    if (downloadFromR2(bucket, indexKey, localIndexPath, r2Endpoint)) {
      try {
        const raw = fs.readFileSync(localIndexPath, 'utf8');
        catalog = JSON.parse(raw);
        console.log('    Found existing global catalog.');
      } catch {
        console.log('    Existing catalog invalid, using fresh template.');
      }
    } else {
      console.log('    No existing catalog found. Creating new catalog.');
    }

    catalog.updated_at = now;
    catalog.plugins = catalog.plugins || {};

    catalog.plugins[params.slug] = {
      name: params.name,
      type: params.type,
      latest_version: params.version,
      latest_tag: params.tag,
      requires_php: params.requiresPhp,
      requires_wp: params.requiresWp,
      description: params.description || (manifest.versions[params.version]?.changelog || ''),
      manifest_url: `${repoBaseUrl}/${params.slug}/info.json`,
      last_updated: now,
    };

    fs.writeFileSync(localIndexPath, JSON.stringify(catalog, null, 2), 'utf8');

    console.log(`--> Uploading updated ${indexKey} to R2...`);
    uploadToR2(bucket, indexKey, localIndexPath, r2Endpoint, 'public, max-age=300, stale-while-revalidate=86400');
    console.log('    [OK] Uploaded ' + indexKey);

    // 3. Purge Cloudflare CDN Cache
    const filesToPurge = [
      `${repoBaseUrl}/index.json`,
      `${repoBaseUrl}/${params.slug}/info.json`,
      `${repoBaseUrl}/${params.slug}/`,
      `${repoBaseUrl}/`,
    ];
    await purgeCloudflareCache(zoneId, apiToken, filesToPurge);

    console.log(`\n[SUCCESS] Successfully published ${params.slug} v${params.version} to ${repoBaseUrl}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n[FATAL ERROR]', err.message);
  process.exit(1);
});
