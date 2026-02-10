# =============================================================================
# Infrastructure Outputs
# =============================================================================

# Cloudflare KV Namespaces
output "session_index_kv_id" {
  description = "Session index KV namespace ID"
  value       = module.session_index_kv.namespace_id
}

output "slack_kv_id" {
  description = "Slack KV namespace ID"
  value       = module.slack_kv.namespace_id
}

# Cloudflare D1 Database
output "d1_database_id" {
  description = "The ID of the D1 database"
  value       = cloudflare_d1_database.main.id
}

# Cloudflare Workers
output "control_plane_url" {
  description = "Control plane worker URL"
  value       = local.control_plane_url
}

output "control_plane_worker_name" {
  description = "Control plane worker name"
  value       = module.control_plane_worker.worker_name
}

output "slack_bot_worker_name" {
  description = "Slack bot worker name"
  value       = module.slack_bot_worker.worker_name
}

# Web App (Cloudflare Workers)
output "web_app_url" {
  description = "Web app URL (Cloudflare Workers)"
  value       = local.web_app_url
}

output "web_app_worker_name" {
  description = "Web app worker name"
  value       = module.web_app.worker_name
}

# Modal
output "modal_app_name" {
  description = "Modal app name"
  value       = module.modal_app.app_name
}

output "modal_health_url" {
  description = "Modal health check endpoint"
  value       = module.modal_app.api_health_url
}

# =============================================================================
# Verification Commands
# =============================================================================

output "verification_commands" {
  description = "Commands to verify the deployment"
  value       = <<-EOF

    # 1. Health check control plane
    curl ${local.control_plane_url}/health

    # 2. Health check Modal
    curl ${module.modal_app.api_health_url}

    # 3. Verify web app deployment
    curl ${local.web_app_url}

    # 4. Test authenticated endpoint (should return 401)
    curl ${local.control_plane_url}/sessions

  EOF
}
