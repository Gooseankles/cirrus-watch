output "url" {
  description = "Dashboard address."
  value       = module.dashboard.url
}

output "web_app_principal_id" {
  description = "Object ID of the shared SPN (the web app's system-assigned identity)."
  value       = module.dashboard.web_app_principal_id
}

output "shared_spn_role_assignments" {
  description = "Roles the shared SPN got, as scope => roles."
  value       = module.dashboard.shared_spn_role_assignments
}

output "sso_app_client_id" {
  description = "Client ID of the sign-in app registration."
  value       = module.dashboard.sso_app_client_id
}

output "sso_app_request" {
  description = "What to ask the app-registration team for when create_sso_app = false."
  value       = module.dashboard.sso_app_request
}

output "sso_identity_client_id" {
  description = "Client ID of the user-assigned identity used for secretless SSO."
  value       = module.dashboard.sso_identity_client_id
}

output "history_storage_url" {
  description = "Blob endpoint of the history storage account."
  value       = module.dashboard.history_storage_url
}
