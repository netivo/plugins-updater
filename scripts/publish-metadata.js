#!/usr/bin/env node
/**
 * Netivo Plugin Repository - Cross-Platform Metadata Publisher
 *
 * Updates plugin release metadata in Cloudflare R2 and purges the CDN cache.
 * Designed to run on any runner (GitHub-hosted or self-hosted) using Node.js.
 *
 * Storage Backends:
 *   1. Native S3 API via Node.js fetch + AWS SigV4 (primary, zero CLI dependencies)
 *   2. AWS CLI (fallback if installed)
 *   3. Cloudflare Wrangler (fallback if installed)
 *
 * Environment variables:
 *   R2_ACCOUNT_ID             Cloudflare Account ID
 *   AWS_ACCESS_KEY_ID         Cloudflare R2 Access Key ID
 *   AWS_SECRET_ACCESS_KEY     Cloudflare R2 Secret Access Key
 *   R2_BUCKET                 Target R2 bucket name (e.g. netivo-wp-updates)
 *   R2_JURISDICTION           Bucket jurisdiction (default: eu)
 *   R2_ENDPOINT               Explicit S3 endpoint (optional)
 *   CF_ZONE_ID                Cloudflare Zone ID (for CDN cache purge)
 *   CF_API_TOKEN              Cloudflare API Token (for CDN cache purge)
 *   REPO_BASE_URL             Base public URL (default: https://updates.netivo.dev)
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

  // Strip leading 'v' from version string if mistakenly passed as v0.7.0
  if (params.version.startsWith('v') && /^[vV]\d+\.\d+/.test(params.version)) {
    params.version = params.version.slice(1);
  }

  if (!params.tag && params.version) {
    params.tag = `v${params.version}`;
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

/**
 * AWS Signature Version 4 signer for S3 requests.
 */
function signS3({ method, url, body = '', accessKeyId, secretAccessKey, headers = {} }) {
  const parsed = new URL(url);
  const host = parsed.host;
  const pathname = parsed.pathname;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');

  const reqHeaders = {
    ...headers,
    'host': host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };

  const sortedKeys = Object.keys(reqHeaders).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${String(reqHeaders[k]).trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    method,
    pathname,
    parsed.search ? parsed.search.slice(1) : '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const region = 'auto';
  const service = 's3';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  function hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
  }

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  reqHeaders['authorization'] = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return reqHeaders;
}

async function s3Fetch({ method, endpoint, bucket, key, body, accessKeyId, secretAccessKey, contentType, cacheControl }) {
  const url = `${endpoint.replace(/\/+$/, '')}/${bucket}/${key}`;
  const customHeaders = {};
  if (contentType) customHeaders['content-type'] = contentType;
  if (cacheControl) customHeaders['cache-control'] = cacheControl;

  const headers = signS3({
    method,
    url,
    body: body || '',
    accessKeyId,
    secretAccessKey,
    headers: customHeaders,
  });

  return await fetch(url, {
    method,
    headers,
    body: body || undefined,
  });
}

async function downloadFromR2(bucket, key, localPath, r2Endpoints, accessKeyId, secretAccessKey) {
  // 1. Primary: Native S3 fetch with AWS SigV4
  if (accessKeyId && secretAccessKey && r2Endpoints && r2Endpoints.length > 0) {
    for (const endpoint of r2Endpoints) {
      try {
        const res = await s3Fetch({
          method: 'GET',
          endpoint,
          bucket,
          key,
          accessKeyId,
          secretAccessKey,
        });

        if (res.status === 200) {
          const text = await res.text();
          fs.writeFileSync(localPath, text, 'utf8');
          return true;
        }
        if (res.status === 404) {
          return false;
        }
      } catch {
        // Try next endpoint candidate
      }
    }
  }

  // 2. Fallback: AWS CLI if available
  if (hasCommand('aws') && accessKeyId && secretAccessKey) {
    for (const endpoint of (r2Endpoints || [])) {
      try {
        execSync(`aws s3 cp "s3://${bucket}/${key}" "${localPath}" --endpoint-url "${endpoint}"`, { stdio: 'pipe' });
        return true;
      } catch {
        // Try next
      }
    }
  }

  // 3. Fallback: Wrangler
  try {
    const jurisdictionFlag = (process.env.R2_JURISDICTION || 'eu') === 'eu' ? '-J eu' : '';
    execSync(`npx wrangler r2 object get "${bucket}/${key}" --file="${localPath}" ${jurisdictionFlag} --remote`, {
      stdio: 'pipe',
      env: { ...process.env, CF_API_TOKEN: undefined, CLOUDFLARE_API_TOKEN: undefined },
    });
    return true;
  } catch {
    return false;
  }
}

async function uploadToR2(bucket, key, localPath, r2Endpoints, cacheControl, accessKeyId, secretAccessKey) {
  const body = fs.readFileSync(localPath, 'utf8');

  // 1. Primary: Native S3 fetch with AWS SigV4
  if (accessKeyId && secretAccessKey && r2Endpoints && r2Endpoints.length > 0) {
    let lastError = null;
    for (const endpoint of r2Endpoints) {
      try {
        const res = await s3Fetch({
          method: 'PUT',
          endpoint,
          bucket,
          key,
          body,
          accessKeyId,
          secretAccessKey,
          contentType: 'application/json',
          cacheControl,
        });

        if (res.status === 200 || res.status === 204) {
          return true;
        }
        const errText = await res.text();
        lastError = new Error(`R2 HTTP ${res.status}: ${errText}`);
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError && !hasCommand('aws')) {
      throw lastError;
    }
  }

  // 2. Fallback: AWS CLI
  if (hasCommand('aws') && accessKeyId && secretAccessKey && r2Endpoints && r2Endpoints.length > 0) {
    execSync(
      `aws s3 cp "${localPath}" "s3://${bucket}/${key}" --endpoint-url "${r2Endpoints[0]}" --content-type "application/json" --cache-control "${cacheControl}"`,
      { stdio: 'inherit' }
    );
    return true;
  }

  // 3. Fallback: Wrangler
  const jurisdictionFlag = (process.env.R2_JURISDICTION || 'eu') === 'eu' ? '-J eu' : '';
  execSync(
    `npx wrangler r2 object put "${bucket}/${key}" --file="${localPath}" --content-type="application/json" --cache-control="${cacheControl}" ${jurisdictionFlag} --remote`,
    {
      stdio: 'inherit',
      env: { ...process.env, CF_API_TOKEN: undefined, CLOUDFLARE_API_TOKEN: undefined },
    }
  );
  return true;
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
    console.warn('    [WARN] Cache purge error:', err.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const params = parseArgs(args);

  if (!params.slug || !params.name || !params.version) {
    console.error('Error: --slug, --name, and --version are required.');
    process.exit(1);
  }

  if (!params.sha256) {
    if (params.zipPath && fs.existsSync(params.zipPath)) {
      params.sha256 = computeSha256(params.zipPath);
    } else {
      console.error('Error: Either --sha256 or an existing --zip-path must be specified.');
      process.exit(1);
    }
  }

  if (!params.downloadUrl) {
    console.error('Error: --download-url is required.');
    process.exit(1);
  }

  const bucket = (process.env.R2_BUCKET || 'netivo-wp-updates').trim();
  const accessKeyId = (process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  const accountId = (process.env.R2_ACCOUNT_ID || (process.env.R2_ENDPOINT ? (process.env.R2_ENDPOINT.match(/https?:\/\/([^.]+)\./) || [])[1] : '')).trim();

  if (accessKeyId && accessKeyId.length !== 32) {
    console.warn(`[WARNING] Cloudflare R2 Access Key ID should be 32 characters (received ${accessKeyId.length} characters).`);
    console.warn('          Ensure you copied the "Access Key ID" from Cloudflare Dashboard > R2 > Manage R2 API Tokens, NOT the API Token or Secret.');
  }

  // Build candidate S3 endpoints (EU jurisdiction first, then global)
  const candidateEndpoints = [];
  if (process.env.R2_ENDPOINT) {
    candidateEndpoints.push(process.env.R2_ENDPOINT);
  }
  if (accountId) {
    candidateEndpoints.push(`https://${accountId}.eu.r2.cloudflarestorage.com`);
    candidateEndpoints.push(`https://${accountId}.r2.cloudflarestorage.com`);
  }
  const r2Endpoints = [...new Set(candidateEndpoints)];

  const repoBaseUrl = (process.env.REPO_BASE_URL || 'https://updates.netivo.dev').replace(/\/+$/, '');
  const zoneId = process.env.CF_ZONE_ID;
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;

  console.log(`=======================================================`);
  console.log(`Publishing release metadata for: ${params.name} (${params.slug})`);
  console.log(`Version: ${params.version} (${params.tag})`);
  console.log(`SHA-256: ${params.sha256}`);
  console.log(`Bucket:  ${bucket}`);
  console.log(`Endpoints: ${r2Endpoints.join(', ')}`);
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
    const exists = await downloadFromR2(bucket, infoKey, localInfoPath, r2Endpoints, accessKeyId, secretAccessKey);
    if (exists) {
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
    await uploadToR2(bucket, infoKey, localInfoPath, r2Endpoints, 'public, max-age=300, stale-while-revalidate=86400', accessKeyId, secretAccessKey);
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
    const catalogExists = await downloadFromR2(bucket, indexKey, localIndexPath, r2Endpoints, accessKeyId, secretAccessKey);
    if (catalogExists) {
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
    await uploadToR2(bucket, indexKey, localIndexPath, r2Endpoints, 'public, max-age=300, stale-while-revalidate=86400', accessKeyId, secretAccessKey);
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
