#!/usr/bin/env bash
# Build and deploy a Next.js app to Cloudflare Workers via @opennextjs/cloudflare
# Required environment variables:
#   CLOUDFLARE_ACCOUNT_ID - Cloudflare account ID
#   CLOUDFLARE_API_TOKEN  - Cloudflare API token
#   PROJECT_PATH          - Absolute path to the Next.js project
#   WORKER_NAME           - Name of the Cloudflare Worker
#   BUILD_ENV_VARS_JSON   - JSON object of build-time env vars (e.g., NEXT_PUBLIC_*)
#   SECRETS_JSON          - JSON object of sensitive env vars to set via wrangler secret

set -euo pipefail

echo "Deploying Next.js app to Cloudflare Workers: ${WORKER_NAME}"
echo "Project path: ${PROJECT_PATH}"

cd "${PROJECT_PATH}" || {
    echo "Error: Failed to change directory to ${PROJECT_PATH}"
    exit 1
}

# Export build-time environment variables (NEXT_PUBLIC_* are inlined at build time)
if [ "${BUILD_ENV_VARS_JSON}" != "{}" ] && [ -n "${BUILD_ENV_VARS_JSON}" ]; then
    echo "Setting build-time environment variables..."
    while IFS= read -r entry; do
        key=$(echo "${entry}" | jq -r '.key')
        value=$(echo "${entry}" | jq -r '.value')
        export "${key}=${value}"
        echo "  ${key}=<set>"
    done < <(echo "${BUILD_ENV_VARS_JSON}" | jq -c 'to_entries | .[]')
fi

# Step 0: Remove any local package-lock.json (monorepo must use root lockfile only)
# A local lockfile confuses @opennextjs/cloudflare monorepo detection.
rm -f package-lock.json

# Step 1: Run Next.js build
echo "Running next build..."
npm run build || {
    echo "Error: next build failed"
    exit 1
}

# Step 2: Fix standalone output for monorepo
# When turbopack.root is set to the monorepo root, standalone output nests files under
# the relative path (e.g., .next/standalone/packages/web/.next/ instead of .next/standalone/.next/).
# @opennextjs/cloudflare expects the flat structure, so symlink if needed.
if [ ! -d ".next/standalone/.next" ] && [ -d ".next/standalone" ]; then
    echo "Fixing standalone output for monorepo structure..."
    # Find the nested .next directory
    NESTED_NEXT=$(find .next/standalone -path "*/.next/BUILD_ID" -exec dirname {} \; 2>/dev/null | head -1)
    if [ -n "${NESTED_NEXT}" ]; then
        echo "  Found nested output at: ${NESTED_NEXT}"
        ln -sf "${NESTED_NEXT#.next/standalone/}" .next/standalone/.next
        # Also symlink node_modules if nested
        NESTED_DIR=$(dirname "${NESTED_NEXT}")
        if [ -d "${NESTED_DIR}/node_modules" ] && [ ! -d ".next/standalone/node_modules" ]; then
            ln -sf "${NESTED_DIR#.next/standalone/}/node_modules" .next/standalone/node_modules
        fi
    fi
fi

# Ensure pages-manifest.json exists (Next.js 16 Turbopack may not generate it for App Router)
PAGES_MANIFEST=".next/standalone/.next/server/pages-manifest.json"
if [ ! -f "${PAGES_MANIFEST}" ]; then
    echo "Creating missing pages-manifest.json..."
    mkdir -p "$(dirname "${PAGES_MANIFEST}")"
    echo '{}' > "${PAGES_MANIFEST}"
fi

# Step 3: Run opennextjs-cloudflare build (skip the Next.js build since we already ran it)
echo "Building with opennextjs-cloudflare..."
npx opennextjs-cloudflare build --skipNextBuild || {
    echo "Error: opennextjs-cloudflare build failed"
    exit 1
}

# Step 4: Deploy with opennextjs-cloudflare
echo "Deploying with opennextjs-cloudflare..."
npx opennextjs-cloudflare deploy || {
    echo "Error: opennextjs-cloudflare deploy failed"
    exit 1
}

# Step 5: Set secrets via wrangler secret bulk (if any)
if [ "${SECRETS_JSON}" != "{}" ] && [ -n "${SECRETS_JSON}" ]; then
    echo "Setting worker secrets..."
    # Try with current auth first; if the API token lacks secret permissions,
    # fall back to wrangler's OAuth token (if available from `wrangler login`).
    if ! echo "${SECRETS_JSON}" | npx wrangler secret bulk --name "${WORKER_NAME}" 2>/dev/null; then
        echo "  Retrying without API token (using wrangler OAuth)..."
        unset CLOUDFLARE_API_TOKEN
        echo "${SECRETS_JSON}" | npx wrangler secret bulk --name "${WORKER_NAME}" || {
            echo "Error: Failed to set worker secrets"
            exit 1
        }
    fi
fi

echo "Next.js app ${WORKER_NAME} deployed successfully to Cloudflare Workers"
