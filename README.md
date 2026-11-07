# Netivo WordPress Plugin Repository

Centralized, serverless WordPress plugin repository and update delivery platform hosted on **Cloudflare R2** and **Cloudflare CDN** (`updates.netivo.pl`).

Rather than querying GitHub API directly (which suffers from a 60 req/hr anonymous rate limit), WordPress sites query this repository to check for updates, verify release checksums, and download release assets directly from GitHub Releases.

---

## 🏗️ Architecture & Storage Layout

- **Global Catalog Endpoint**: `https://updates.netivo.pl/` or `https://updates.netivo.pl/index.json`
- **Plugin Manifests & History**: `https://updates.netivo.pl/<plugin-slug>/info.json`
- **JSON Schemas**: `https://updates.netivo.pl/schemas/`
- **Asset Storage**: Binary `.zip` files remain hosted on GitHub Releases (`github.com/netivo/<repo>/releases/download/...`). Cloudflare R2 stores only lightweight JSON manifests and schemas.

```text
netivo-wp-updates (Cloudflare R2 Bucket)
├── index.json                                  # Global catalog of all Netivo plugins
├── schemas/
│   ├── repository.v1.json                     # JSON Schema for index.json
│   └── plugin.v1.json                         # JSON Schema for info.json
├── netivo-action-logger-mu/
│   └── info.json                              # Full version history + latest release
├── netivo-crm-sync/
│   └── info.json
└── ...
```

---

## 📁 Repository Structure

```text
netivo-plugins/
├── .github/
│   └── actions/
│       └── publish-plugin-metadata/           # Composite GitHub Action for plugin repos
│           └── action.yml
├── catalog/                                   # Local seed/reference catalog data
│   ├── index.json                             # Global catalog
│   └── netivo-action-logger-mu/
│       └── info.json                          # Release history for Action Logger
├── client/
│   └── src/
│       └── RepoClient.php                     # Reusable WordPress client library
├── schemas/
│   ├── plugin.v1.json                         # JSON Schema for plugin manifests
│   └── repository.v1.json                     # JSON Schema for repository catalog
├── scripts/
│   ├── publish-metadata.sh                    # CI/CD script to push metadata to R2
│   ├── seed-r2.sh                             # Seeds R2 with initial schemas & catalog
│   └── validate.js                            # Validates catalog and schemas
├── worker/                                    # Cloudflare Worker edge routing & caching
│   ├── src/
│   │   └── index.ts                           # Worker logic (CORS, 304 ETag, URL rewrite)
│   ├── package.json
│   ├── tsconfig.json
│   └── wrangler.jsonc                         # Cloudflare Wrangler configuration
├── package.json
├── PLAN.md                                    # Architectural specification & plan
└── README.md
```

---

## 🚀 Setup & Deployment Guide

### 1. Cloudflare R2 Bucket Setup
1. In Cloudflare Dashboard, navigate to **R2** > **Create Bucket**.
2. Bucket name: `netivo-wp-updates`.
3. In **Settings** > **Custom Domains**, connect `updates.netivo.pl`.
4. Generate R2 API Tokens (**Manage R2 API Tokens** > **Create API token**) with **Object Read & Write** permissions. Note down:
   - Account ID
   - Access Key ID
   - Secret Access Key

### 2. Initial Seeding to R2
Run the seed script to push the initial catalog and schemas to R2:
```bash
export R2_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
export AWS_ACCESS_KEY_ID="<R2_ACCESS_KEY_ID>"
export AWS_SECRET_ACCESS_KEY="<R2_SECRET_ACCESS_KEY>"
export R2_BUCKET="netivo-wp-updates"

bash scripts/seed-r2.sh
```

### 3. Deploy Cloudflare Routing Worker
The worker ensures clean URL routing (`/` -> `/index.json`, `/<slug>/` -> `/<slug>/info.json`), adds CORS headers, and handles HTTP 304 ETag validation.
```bash
cd worker
npm install
npm run deploy
```

---

## 🔄 CI/CD Plugin Publishing

Add this step to any plugin's release workflow (e.g. `.github/workflows/split-wp-mu-plugin.yml`) after building the `.zip` file:

```yaml
- name: Publish Metadata to Cloudflare Plugin Repository
  if: ${{ startsWith(github.ref, 'refs/tags/') }}
  uses: netivo/netivo-plugins/.github/actions/publish-plugin-metadata@v1
  with:
    slug: 'netivo-action-logger-mu'
    name: 'Netivo Action Logger (MU)'
    type: 'mu-plugin'
    version: '${{ steps.version.outputs.version }}'
    zip-path: '${{ github.workspace }}/netivo-action-logger-mu-${{ github.ref_name }}.zip'
    download-url: 'https://github.com/netivo/wp-action-logger-plugin/releases/download/${{ github.ref_name }}/netivo-action-logger-mu-${{ github.ref_name }}.zip'
    requires-php: '8.2'
    requires-wp: '6.3'
    tested-wp: '6.7'
    changelog: 'Release ${{ github.ref_name }}'
    r2-account-id: ${{ secrets.CLOUDFLARE_R2_ACCOUNT_ID }}
    r2-access-key-id: ${{ secrets.CLOUDFLARE_R2_ACCESS_KEY_ID }}
    r2-secret-access-key: ${{ secrets.CLOUDFLARE_R2_SECRET_ACCESS_KEY }}
    r2-bucket-name: ${{ secrets.CLOUDFLARE_R2_BUCKET_NAME }}
    cf-zone-id: ${{ secrets.CLOUDFLARE_ZONE_ID }}
    cf-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

---

## 🔌 WordPress Client Integration

Inside any WordPress plugin or Must-Use plugin, use `Netivo\PluginRepository\Client\RepoClient`:

```php
use Netivo\PluginRepository\Client\RepoClient;

$client = new RepoClient( 'netivo-action-logger-mu' );
$release = $client->latest_release();

if ( null !== $release && version_compare( $release['version'], CURRENT_VERSION, '>' ) ) {
    // Download release['zip_url']
    // Validate checksum: RepoClient::verify_checksum( $downloadedZipPath, $release['sha256'] );
    // Unzip & install
}
```

---

## 🧪 Validation & Testing

Run schema and manifest validation:
```bash
npm test
```
