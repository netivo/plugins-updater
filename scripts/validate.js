#!/usr/bin/env node
/**
 * Netivo Plugin Repository - Manifest & Catalog Validator
 *
 * Validates catalog/index.json and all catalog/<slug>/info.json files against
 * required schemas and strict syntax/integrity rules.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CATALOG_DIR = path.join(ROOT_DIR, 'catalog');
const SCHEMAS_DIR = path.join(ROOT_DIR, 'schemas');

let errors = 0;

function logError(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  errors++;
}

function logOk(msg) {
  console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    logError(`Failed to parse JSON file: ${filePath} (${err.message})`);
    return null;
  }
}

// 1. Validate Schemas exist and are valid JSON
console.log('==> Validating JSON Schemas...');
for (const schemaFile of ['repository.v1.json', 'plugin.v1.json']) {
  const p = path.join(SCHEMAS_DIR, schemaFile);
  if (!fs.existsSync(p)) {
    logError(`Missing schema file: ${p}`);
  } else {
    const s = readJson(p);
    if (s) {
      logOk(`Valid schema: ${schemaFile}`);
    }
  }
}

// 2. Validate catalog/index.json
console.log('\n==> Validating Global Catalog (catalog/index.json)...');
const indexPath = path.join(CATALOG_DIR, 'index.json');
if (!fs.existsSync(indexPath)) {
  logError(`Missing catalog index at: ${indexPath}`);
} else {
  const index = readJson(indexPath);
  if (index) {
    if (!index.name || typeof index.name !== 'string') logError('index.json: missing "name"');
    if (!index.updated_at || isNaN(Date.parse(index.updated_at))) logError('index.json: invalid "updated_at" ISO date');
    if (!index.plugins || typeof index.plugins !== 'object') {
      logError('index.json: missing "plugins" object');
    } else {
      for (const [slug, meta] of Object.entries(index.plugins)) {
        if (!meta.name) logError(`index.json plugins.${slug}: missing "name"`);
        if (!meta.type) logError(`index.json plugins.${slug}: missing "type"`);
        if (!meta.latest_version) logError(`index.json plugins.${slug}: missing "latest_version"`);
        if (!meta.latest_tag) logError(`index.json plugins.${slug}: missing "latest_tag"`);
        if (!meta.manifest_url || !meta.manifest_url.startsWith('http')) {
          logError(`index.json plugins.${slug}: invalid "manifest_url"`);
        }
      }
      logOk(`catalog/index.json contains ${Object.keys(index.plugins).length} valid plugin entry/entries.`);
    }
  }
}

// 3. Validate each catalog/<slug>/info.json
console.log('\n==> Validating Plugin Manifests (catalog/**/info.json)...');
if (fs.existsSync(CATALOG_DIR)) {
  const entries = fs.readdirSync(CATALOG_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const slug = entry.name;
      const manifestPath = path.join(CATALOG_DIR, slug, 'info.json');

      if (!fs.existsSync(manifestPath)) {
        logError(`Plugin directory '${slug}' is missing info.json`);
        continue;
      }

      const manifest = readJson(manifestPath);
      if (!manifest) continue;

      if (manifest.slug !== slug) {
        logError(`${slug}/info.json: slug field "${manifest.slug}" does not match directory name "${slug}"`);
      }
      if (!manifest.name) logError(`${slug}/info.json: missing "name"`);
      if (!manifest.latest) logError(`${slug}/info.json: missing "latest" pointer`);
      if (!manifest.versions || typeof manifest.versions !== 'object') {
        logError(`${slug}/info.json: missing "versions" map`);
      } else {
        if (!manifest.versions[manifest.latest]) {
          logError(`${slug}/info.json: latest version "${manifest.latest}" is not present in "versions" map`);
        }

        for (const [ver, vdata] of Object.entries(manifest.versions)) {
          if (vdata.version !== ver) {
            logError(`${slug}/info.json version ${ver}: version key mismatch (${vdata.version})`);
          }
          if (!vdata.tag) logError(`${slug}/info.json version ${ver}: missing tag`);
          if (!vdata.download_url || !vdata.download_url.startsWith('https://')) {
            logError(`${slug}/info.json version ${ver}: invalid download_url`);
          }
          if (!vdata.checksum || vdata.checksum.type !== 'sha256' || !/^[a-f0-9]{64}$/i.test(vdata.checksum.value)) {
            logError(`${slug}/info.json version ${ver}: invalid sha256 checksum (${vdata.checksum?.value})`);
          }
        }
        logOk(`${slug}/info.json is valid (${Object.keys(manifest.versions).length} versions recorded, latest: v${manifest.latest})`);
      }
    }
  }
}

if (errors > 0) {
  console.error(`\n\x1b[31mValidation failed with ${errors} error(s).\x1b[0m\n`);
  process.exit(1);
} else {
  console.log('\n\x1b[32mAll manifests and schemas passed validation successfully!\x1b[0m\n');
  process.exit(0);
}
