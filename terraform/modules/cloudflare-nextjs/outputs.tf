output "worker_name" {
  description = "The name of the deployed Cloudflare Worker"
  value       = var.worker_name
}

output "worker_url" {
  description = "The workers.dev URL of the deployed worker"
  value       = "https://${var.worker_name}.${var.cloudflare_worker_subdomain}.workers.dev"
}

output "deploy_id" {
  description = "ID of the deployment resource (for dependency tracking)"
  value       = null_resource.deploy.id
}
