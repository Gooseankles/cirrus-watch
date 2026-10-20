output "url" {
  description = "Dashboard address."
  value       = local.site_url
}

output "web_app_principal_id" {
  description = "Object ID of the web app's system-assigned identity (the scan identity). Grant it extra roles here, e.g. Key Vault access for the secret-expiry tool."
  value       = azurerm_linux_web_app.this.identity[0].principal_id
}

output "sso_app_client_id" {
  description = "Client ID of the sign-in app registration."
  value       = azuread_application.dashboard.client_id
}

output "sso_identity_client_id" {
  description = "Client ID of the user-assigned identity used for secretless SSO."
  value       = azurerm_user_assigned_identity.sso.client_id
}
