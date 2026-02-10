# Cloudflare Next.js Module
# Deploys a Next.js app to Cloudflare Workers via @opennextjs/cloudflare
# Uses null_resource with local-exec provisioners (same pattern as modal-app)

# Generate wrangler.json with the correct worker name and plain-text vars
resource "local_file" "wrangler_json" {
  filename = "${var.project_path}/wrangler.json"
  content = jsonencode(merge(
    {
      name               = var.worker_name
      main               = ".open-next/worker.js"
      compatibility_date  = "2024-09-23"
      compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
      assets = {
        binding   = "ASSETS"
        directory = ".open-next/assets"
      }
    },
    length(var.plain_text_vars) > 0 ? {
      vars = var.plain_text_vars
    } : {}
  ))
}

# Build and deploy
resource "null_resource" "deploy" {
  triggers = {
    source_hash  = var.source_hash
    worker_name  = var.worker_name
    wrangler_json = local_file.wrangler_json.id
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/deploy.sh"
    interpreter = ["bash"]

    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
      PROJECT_PATH          = var.project_path
      WORKER_NAME           = var.worker_name
      BUILD_ENV_VARS_JSON   = jsonencode(var.build_env_vars)
      SECRETS_JSON          = jsonencode(var.secrets)
    }
  }

  depends_on = [local_file.wrangler_json]
}
