output "url" {
  description = "Dashboard address."
  value       = local.site_url
}

output "resource_group_name" {
  description = "Resource group the dashboard lives in."
  value       = azurerm_resource_group.this.name
}

output "web_app_id" {
  description = "Resource ID of the web app."
  value       = azurerm_linux_web_app.this.id
}

output "shared_spn_role_assignments" {
  description = "Roles the shared SPN got from shared_spn_access, as scope => roles."
  value = {
    for a in var.shared_spn_access : a.scope => a.roles...
  }
}

output "history_storage_url" {
  description = "Blob endpoint of the history storage account (null when create_history_storage = false)."
  value       = var.create_history_storage ? azurerm_storage_account.history[0].primary_blob_endpoint : null
}

output "web_app_principal_id" {
  description = "Object ID of the web app's system-assigned identity (the shared SPN). Extra roles can go in shared_spn_access or be granted elsewhere with this ID."
  value       = azurerm_linux_web_app.this.identity[0].principal_id
}

output "sso_app_client_id" {
  description = "Client ID of the sign-in app registration."
  value       = local.sso_client_id
}

output "sso_app_request" {
  description = "What to ask the app-registration team for when create_sso_app = false."
  value       = var.create_sso_app ? "Not needed: Terraform created the app registration." : <<-EOT
    Sign-in app registration for the Azure tools dashboard (${var.name})
    - Single tenant (this organization only).
    - Platform Web, redirect URI: ${local.redirect_uri}
      Front-channel logout / home page: ${local.site_url}
    - No API permissions needed beyond the default sign-in (openid, profile).
    - App roles (allowed member types Users/Groups):
        value "Admin"  - run scans and change settings
        value "User"   - read-only
    - Enterprise application: "Assignment required" = Yes; assign the people or groups to Admin or User.
    - Credential, preferred (no secret): Federated credential, scenario "Managed identity" / "Other issuer":
        issuer:   ${local.sso_fic_issuer}
        subject:  ${local.sso_fic_subject}   (object ID of managed identity id-${var.name}-sso)
        audience: api://AzureADTokenExchange
      Otherwise a client secret, set as sso_client_secret.
    Send back: the Application (client) ID -> sso_app_client_id.
  EOT
}

output "sso_identity_client_id" {
  description = "Client ID of the user-assigned identity used for secretless SSO."
  value       = azurerm_user_assigned_identity.sso.client_id
}
