variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token"
  type        = string
  sensitive   = true
}

variable "worker_name" {
  description = "Name of the Cloudflare Worker"
  type        = string
}

variable "cloudflare_worker_subdomain" {
  description = "Cloudflare Workers subdomain (e.g., 'myaccount' in worker.myaccount.workers.dev)"
  type        = string
}

variable "project_path" {
  description = "Absolute path to the Next.js project (packages/web)"
  type        = string
}

variable "source_hash" {
  description = "Hash of source files to trigger redeployment on changes"
  type        = string
  default     = ""
}

variable "build_env_vars" {
  description = "Environment variables needed at build time (inlined by Next.js via NEXT_PUBLIC_*)"
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "plain_text_vars" {
  description = "Non-sensitive environment variables set on the worker"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Sensitive environment variables set via wrangler secret bulk"
  type        = map(string)
  default     = {}
  sensitive   = true
}
