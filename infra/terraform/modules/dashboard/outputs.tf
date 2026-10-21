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
        value "Admin"  - everything: every tenant, Run now, Settings
        value "User"   - read-only, every tenant%{for k, c in var.customers}
        value "Admin-${k}"  - ${c.name}: read and run its scans
        value "User-${k}"   - ${c.name}: read-only%{endfor}
    - Enterprise application: "Assignment required" = Yes; assign groups (or people) to the roles.
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

output "role_groups" {
  description = "Entra security group per dashboard role (role => group object ID). Add people to these groups; one person can be in several customers' groups."
  value       = { for role, g in azuread_group.role : role => g.object_id }
}

output "customer_scan_app_client_id" {
  description = "Client ID of the multi-tenant scan app that signs in to customer tenants (null without customers)."
  value       = local.has_customers ? local.customer_scan_app_client_id : null
}

output "customer_scan_identity_client_id" {
  description = "Client ID of the managed identity the scan app trusts (null without customers)."
  value       = local.has_customers ? azurerm_user_assigned_identity.customers[0].client_id : null
}

output "customer_containers" {
  description = "History storage container per customer."
  value       = local.customer_containers
}

output "customer_onboarding" {
  description = "Per customer: what an admin in that tenant does once (consent and read roles). Terraform does not touch customer tenants."
  value = {
    for k, c in var.customers : k => c.client_id == "" ? join("\n", concat([
      "${c.name} (tenant ${c.tenant_id})",
      "1. A Global Administrator there opens this link and accepts (creates the scan app in their tenant, grants its Graph read permissions):",
      "   https://login.microsoftonline.com/${c.tenant_id}/adminconsent?client_id=${local.customer_scan_app_client_id}",
      "2. Grant it read roles (an Owner or User Access Administrator, signed in to that tenant), per subscription or on a management group:",
      ], [
      for pair in setproduct(length(c.subscription_ids) > 0 ? c.subscription_ids : ["<subscription-id>"], local.scan_roles) :
      "   az role assignment create --assignee ${local.customer_scan_app_client_id} --role \"${pair[1]}\" --scope /subscriptions/${pair[0]}"
      ])) : join("\n", [
      "${c.name} (tenant ${c.tenant_id}) uses its own app registration ${c.client_id}.",
      "In that tenant, add a federated credential to it (Certificates & secrets > Federated credentials > Other issuer):",
      "   issuer:   ${local.sso_fic_issuer}",
      "   subject:  ${local.customer_fic_subject}   (object ID of managed identity id-${var.name}-customers)",
      "   audience: api://AzureADTokenExchange",
      "Then grant that app Graph application permissions (${join(", ", var.graph_permissions)}) with admin consent, and Reader, Cost Management Reader and Key Vault Reader on the subscriptions.",
    ])
  }
}

output "private_network" {
  description = "VNet integration subnet and storage private endpoint (null when private_network = false)."
  value = var.private_network ? {
    app_subnet_id         = local.app_subnet_id
    private_endpoint_id   = local.history_private ? azurerm_private_endpoint.history_blob[0].id : null
    storage_public_access = "Disabled"
  } : null
}
