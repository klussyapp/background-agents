# =============================================================================
# Open-Inspect - Production Environment
# =============================================================================
# This configuration deploys the complete Open-Inspect infrastructure:
# - Cloudflare Workers (control-plane, slack-bot, web app)
# - Cloudflare KV Namespaces
# - Modal Sandbox Infrastructure
# =============================================================================

locals {
  name_suffix = var.deployment_name

  # URLs for cross-service configuration
  control_plane_host = "open-inspect-control-plane-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  control_plane_url  = "https://${local.control_plane_host}"
  web_app_url        = "https://open-inspect-web-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  ws_url             = "wss://${local.control_plane_host}"

  # Worker script paths (deterministic output locations)
  control_plane_script_path = "${var.project_root}/packages/control-plane/dist/index.js"
  slack_bot_script_path     = "${var.project_root}/packages/slack-bot/dist/index.js"
}

# =============================================================================
# Cloudflare KV Namespaces
# =============================================================================

module "session_index_kv" {
  source = "../../modules/cloudflare-kv"

  account_id     = var.cloudflare_account_id
  namespace_name = "open-inspect-session-index-${local.name_suffix}"
}

module "slack_kv" {
  source = "../../modules/cloudflare-kv"

  account_id     = var.cloudflare_account_id
  namespace_name = "open-inspect-slack-kv-${local.name_suffix}"
}

# =============================================================================
# Cloudflare D1 Database
# =============================================================================

resource "cloudflare_d1_database" "main" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-${local.name_suffix}"

  read_replication = {
    mode = "disabled"
  }
}

resource "null_resource" "d1_migrations" {
  depends_on = [cloudflare_d1_database.main]

  triggers = {
    database_id = cloudflare_d1_database.main.id
    migrations_sha = sha256(join(",", [
      for f in sort(fileset("${var.project_root}/terraform/d1/migrations", "*.sql")) :
      filesha256("${var.project_root}/terraform/d1/migrations/${f}")
    ]))
  }

  provisioner "local-exec" {
    command = "bash ${var.project_root}/scripts/d1-migrate.sh ${cloudflare_d1_database.main.name} ${var.project_root}/terraform/d1/migrations"

    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
    }
  }
}

# =============================================================================
# Cloudflare Workers
# =============================================================================

# Build control-plane worker bundle (only runs during apply, not plan)
resource "null_resource" "control_plane_build" {
  triggers = {
    # Rebuild when source files change - use timestamp to always check
    # In CI, this ensures fresh builds; locally, npm handles caching
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/control-plane"
  }
}

module "control_plane_worker" {
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-control-plane-${local.name_suffix}"
  script_path = local.control_plane_script_path

  kv_namespaces = [
    {
      binding_name = "REPOS_CACHE"
      namespace_id = module.session_index_kv.namespace_id
    }
  ]

  d1_databases = [
    {
      binding_name = "DB"
      database_id  = cloudflare_d1_database.main.id
    }
  ]

  service_bindings = [
    {
      binding_name = "SLACK_BOT"
      service_name = "open-inspect-slack-bot-${local.name_suffix}"
    }
  ]

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = [
    { name = "GITHUB_CLIENT_ID", value = var.github_client_id },
    { name = "WEB_APP_URL", value = local.web_app_url },
    { name = "WORKER_URL", value = local.control_plane_url },
    { name = "MODAL_WORKSPACE", value = var.modal_workspace },
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
  ]

  secrets = [
    { name = "GITHUB_CLIENT_SECRET", value = var.github_client_secret },
    { name = "TOKEN_ENCRYPTION_KEY", value = var.token_encryption_key },
    { name = "REPO_SECRETS_ENCRYPTION_KEY", value = var.repo_secrets_encryption_key },
    { name = "MODAL_TOKEN_ID", value = var.modal_token_id },
    { name = "MODAL_TOKEN_SECRET", value = var.modal_token_secret },
    { name = "MODAL_API_SECRET", value = var.modal_api_secret },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
    # GitHub App credentials for /repos endpoint (listInstallationRepositories)
    { name = "GITHUB_APP_ID", value = var.github_app_id },
    { name = "GITHUB_APP_PRIVATE_KEY", value = var.github_app_private_key },
    { name = "GITHUB_APP_INSTALLATION_ID", value = var.github_app_installation_id },
  ]

  durable_objects = [
    { binding_name = "SESSION", class_name = "SessionDO" }
  ]

  enable_durable_object_bindings = var.enable_durable_object_bindings

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]
  migration_tag       = "v1"

  depends_on = [null_resource.control_plane_build, module.session_index_kv, null_resource.d1_migrations]
}

# Build slack-bot worker bundle (only runs during apply, not plan)
resource "null_resource" "slack_bot_build" {
  triggers = {
    # Rebuild when source files change - use timestamp to always check
    # In CI, this ensures fresh builds; locally, npm handles caching
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/slack-bot"
  }
}

module "slack_bot_worker" {
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-slack-bot-${local.name_suffix}"
  script_path = local.slack_bot_script_path

  kv_namespaces = [
    {
      binding_name = "SLACK_KV"
      namespace_id = module.slack_kv.namespace_id
    }
  ]

  service_bindings = [
    {
      binding_name = "CONTROL_PLANE"
      service_name = "open-inspect-control-plane-${local.name_suffix}"
    }
  ]

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = [
    { name = "CONTROL_PLANE_URL", value = local.control_plane_url },
    { name = "WEB_APP_URL", value = local.web_app_url },
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
    { name = "DEFAULT_MODEL", value = "claude-haiku-4-5" },
    { name = "CLASSIFICATION_MODEL", value = "claude-haiku-4-5" },
  ]

  secrets = [
    { name = "SLACK_BOT_TOKEN", value = var.slack_bot_token },
    { name = "SLACK_SIGNING_SECRET", value = var.slack_signing_secret },
    { name = "ANTHROPIC_API_KEY", value = var.anthropic_api_key },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [null_resource.slack_bot_build, module.slack_kv, module.control_plane_worker]
}

# =============================================================================
# Cloudflare Web App
# =============================================================================

# Build @open-inspect/shared before the web app (it depends on the shared package)
resource "null_resource" "web_shared_build" {
  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/shared"
  }
}

# Calculate hash of web source files for change detection
data "external" "web_source_hash" {
  program = ["bash", "-c", <<-EOF
    cd ${var.project_root}/packages/web
    if command -v sha256sum &> /dev/null; then
      hash=$(find src public -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.css" -o -name "*.json" \) -exec sha256sum {} \; 2>/dev/null | sha256sum | cut -d' ' -f1)
    else
      hash=$(find src public -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.css" -o -name "*.json" \) -exec shasum -a 256 {} \; 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "web_app" {
  source = "../../modules/cloudflare-nextjs"

  cloudflare_account_id       = var.cloudflare_account_id
  cloudflare_api_token        = var.cloudflare_api_token
  cloudflare_worker_subdomain = var.cloudflare_worker_subdomain

  worker_name  = "open-inspect-web-${local.name_suffix}"
  project_path = "${var.project_root}/packages/web"
  source_hash  = data.external.web_source_hash.result.hash

  # Build-time env vars (NEXT_PUBLIC_* are inlined by Next.js at build time)
  build_env_vars = {
    NEXT_PUBLIC_WS_URL = local.ws_url
  }

  # Non-sensitive runtime env vars
  plain_text_vars = {
    GITHUB_CLIENT_ID   = var.github_client_id
    NEXTAUTH_URL       = local.web_app_url
    CONTROL_PLANE_URL  = local.control_plane_url
    ALLOWED_USERS      = var.allowed_users
    ALLOWED_EMAIL_DOMAINS = var.allowed_email_domains
  }

  # Sensitive runtime env vars (set via wrangler secret bulk)
  secrets = {
    GITHUB_CLIENT_SECRET    = var.github_client_secret
    NEXTAUTH_SECRET         = var.nextauth_secret
    INTERNAL_CALLBACK_SECRET = var.internal_callback_secret
  }

  depends_on = [null_resource.web_shared_build]
}

# =============================================================================
# Modal Sandbox Infrastructure
# =============================================================================

# Calculate hash of Modal source files for change detection
# Uses sha256sum (Linux) or shasum (macOS) for cross-platform compatibility
# Includes both .py and .js files (sandbox plugins are JavaScript)
data "external" "modal_source_hash" {
  program = ["bash", "-c", <<-EOF
    cd ${var.project_root}/packages/modal-infra
    if command -v sha256sum &> /dev/null; then
      hash=$(find src -type f \( -name "*.py" -o -name "*.js" \) -exec sha256sum {} \; | sha256sum | cut -d' ' -f1)
    else
      hash=$(find src -type f \( -name "*.py" -o -name "*.js" \) -exec shasum -a 256 {} \; | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "modal_app" {
  source = "../../modules/modal-app"

  modal_token_id     = var.modal_token_id
  modal_token_secret = var.modal_token_secret

  app_name      = "open-inspect"
  workspace     = var.modal_workspace
  deploy_path   = "${var.project_root}/packages/modal-infra"
  deploy_module = "deploy"
  source_hash   = data.external.modal_source_hash.result.hash

  volume_name = "open-inspect-data"

  secrets = [
    {
      name = "llm-api-keys"
      values = {
        ANTHROPIC_API_KEY = var.anthropic_api_key
      }
    },
    {
      name = "github-app"
      values = {
        GITHUB_APP_ID              = var.github_app_id
        GITHUB_APP_PRIVATE_KEY     = var.github_app_private_key
        GITHUB_APP_INSTALLATION_ID = var.github_app_installation_id
      }
    },
    {
      name = "internal-api"
      values = {
        MODAL_API_SECRET             = var.modal_api_secret
        ALLOWED_CONTROL_PLANE_HOSTS  = local.control_plane_host
      }
    }
  ]
}
