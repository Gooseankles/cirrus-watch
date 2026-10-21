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

output "role_groups" {
  description = "Entra security group per dashboard role (role => group object ID)."
  value       = module.dashboard.role_groups
}

output "customer_scan_identity_client_id" {
  description = "Client ID of the managed identity each customer's app registration trusts."
  value       = module.dashboard.customer_scan_identity_client_id
}

output "customer_containers" {
  description = "History storage container per customer."
  value       = module.dashboard.customer_containers
}

output "customer_onboarding" {
  description = "Per customer: the consent link and role commands an admin in that tenant runs once."
  value       = module.dashboard.customer_onboarding
}

output "private_network" {
  description = "VNet integration subnet and storage private endpoint."
  value       = module.dashboard.private_network
}
