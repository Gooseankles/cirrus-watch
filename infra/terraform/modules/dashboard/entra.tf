# --- SSO app registration ---

locals {
  sso_client_id   = var.create_sso_app ? azuread_application.dashboard[0].client_id : var.sso_app_client_id
  sso_secretless  = var.create_sso_app || var.sso_client_secret == ""
  sso_fic_issuer  = "https://login.microsoftonline.com/${data.azuread_client_config.current.tenant_id}/v2.0"
  sso_fic_subject = azurerm_user_assigned_identity.sso.principal_id
}

resource "random_uuid" "role_admin" {}
resource "random_uuid" "role_user" {}

resource "azuread_application" "dashboard" {
  count            = var.create_sso_app ? 1 : 0
  display_name     = "Azure tools dashboard (${var.name})"
  sign_in_audience = "AzureADMyOrg"
  owners           = [data.azuread_client_config.current.object_id]

  web {
    redirect_uris = [local.redirect_uri]
    homepage_url  = local.site_url
    logout_url    = local.site_url
  }

  app_role {
    id                   = random_uuid.role_admin.result
    value                = "Admin"
    display_name         = "Admin"
    description          = "Run scans and change settings."
    allowed_member_types = ["User"]
    enabled              = true
  }

  app_role {
    id                   = random_uuid.role_user.result
    value                = "User"
    display_name         = "User"
    description          = "Read-only: findings, logs and access lookup."
    allowed_member_types = ["User"]
    enabled              = true
  }
}

resource "azuread_service_principal" "dashboard" {
  count                        = var.create_sso_app ? 1 : 0
  client_id                    = azuread_application.dashboard[0].client_id
  app_role_assignment_required = true # only people assigned below can sign in
  owners                       = [data.azuread_client_config.current.object_id]
}

# Secretless sign-in: the app registration accepts tokens from the web app's
# user-assigned identity instead of a client secret.
resource "azuread_application_federated_identity_credential" "sso" {
  count          = var.create_sso_app ? 1 : 0
  application_id = azuread_application.dashboard[0].id
  display_name   = "app-service-${var.name}"
  description    = "User-assigned identity of the dashboard web app"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = local.sso_fic_issuer
  subject        = local.sso_fic_subject
}

resource "azuread_app_role_assignment" "admins" {
  for_each            = var.create_sso_app ? toset(var.admin_principal_ids) : toset([])
  app_role_id         = random_uuid.role_admin.result
  principal_object_id = each.value
  resource_object_id  = azuread_service_principal.dashboard[0].object_id
}

resource "azuread_app_role_assignment" "users" {
  for_each            = var.create_sso_app ? toset(var.user_principal_ids) : toset([])
  app_role_id         = random_uuid.role_user.result
  principal_object_id = each.value
  resource_object_id  = azuread_service_principal.dashboard[0].object_id
}

# --- Microsoft Graph permissions for the scan identity ---

data "azuread_service_principal" "msgraph" {
  count     = var.grant_graph_permissions ? 1 : 0
  client_id = "00000003-0000-0000-c000-000000000000"
}

resource "azuread_app_role_assignment" "graph" {
  for_each            = var.grant_graph_permissions ? toset(var.graph_permissions) : toset([])
  app_role_id         = data.azuread_service_principal.msgraph[0].app_role_ids[each.value]
  principal_object_id = azurerm_linux_web_app.this.identity[0].principal_id
  resource_object_id  = data.azuread_service_principal.msgraph[0].object_id
}
