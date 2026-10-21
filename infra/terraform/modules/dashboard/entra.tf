# --- SSO app registration ---

locals {
  sso_client_id   = var.create_sso_app ? azuread_application.dashboard[0].client_id : var.sso_app_client_id
  sso_secretless  = var.create_sso_app || var.sso_client_secret == ""
  sso_fic_issuer  = "https://login.microsoftonline.com/${data.azuread_client_config.current.tenant_id}/v2.0"
  sso_fic_subject = azurerm_user_assigned_identity.sso.principal_id
}

resource "random_uuid" "role_admin" {}
resource "random_uuid" "role_user" {}
resource "random_uuid" "customer_role" {
  for_each = toset(flatten([for k in keys(var.customers) : ["Admin-${k}", "User-${k}"]]))
}

locals {
  # Every dashboard role: the global ones and Admin-<key> / User-<key> per
  # customer, with who gets it.
  dashboard_roles = merge(
    {
      Admin = { id = random_uuid.role_admin.result, members = var.admin_principal_ids, description = "Everything: every tenant, Run now, Settings." }
      User  = { id = random_uuid.role_user.result, members = var.user_principal_ids, description = "Read-only, every tenant: findings, logs and access lookup." }
    },
    { for k, c in var.customers : "Admin-${k}" => { id = random_uuid.customer_role["Admin-${k}"].result, members = c.admin_members, description = "${c.name}: read and run its scans." } },
    { for k, c in var.customers : "User-${k}" => { id = random_uuid.customer_role["User-${k}"].result, members = c.user_members, description = "${c.name}: read-only." } },
  )
  role_members = merge([
    for role, r in local.dashboard_roles : { for m in r.members : "${role}|${m}" => { role = role, member = m } }
  ]...)
  group_prefix = var.role_group_prefix != "" ? var.role_group_prefix : "Azure tools dashboard (${var.name})"
}

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

  # "User" member type covers users and groups.
  dynamic "app_role" {
    for_each = local.dashboard_roles
    content {
      id                   = app_role.value.id
      value                = app_role.key
      display_name         = app_role.key
      description          = app_role.value.description
      allowed_member_types = ["User"]
      enabled              = true
    }
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

# --- Who gets which role ---
#
# create_role_groups = true: one security group per role, assigned to it;
# the listed people become members (add more in Entra, also to several
# customers' groups). false: the people are assigned to the roles directly.

resource "azuread_group" "role" {
  for_each         = var.create_role_groups ? local.dashboard_roles : {}
  display_name     = "${local.group_prefix} ${each.key}"
  description      = each.value.description
  security_enabled = true
  owners           = [data.azuread_client_config.current.object_id]
}

resource "azuread_group_member" "role" {
  for_each         = var.create_role_groups ? local.role_members : {}
  group_object_id  = azuread_group.role[each.value.role].object_id
  member_object_id = each.value.member
}

resource "azuread_app_role_assignment" "role_groups" {
  for_each            = var.create_role_groups && var.create_sso_app ? local.dashboard_roles : {}
  app_role_id         = each.value.id
  principal_object_id = azuread_group.role[each.key].object_id
  resource_object_id  = azuread_service_principal.dashboard[0].object_id
}

resource "azuread_app_role_assignment" "admins" {
  for_each            = var.create_sso_app && !var.create_role_groups ? toset(var.admin_principal_ids) : toset([])
  app_role_id         = random_uuid.role_admin.result
  principal_object_id = each.value
  resource_object_id  = azuread_service_principal.dashboard[0].object_id
}

resource "azuread_app_role_assignment" "users" {
  for_each            = var.create_sso_app && !var.create_role_groups ? toset(var.user_principal_ids) : toset([])
  app_role_id         = random_uuid.role_user.result
  principal_object_id = each.value
  resource_object_id  = azuread_service_principal.dashboard[0].object_id
}

resource "azuread_app_role_assignment" "customer_members" {
  for_each            = var.create_sso_app && !var.create_role_groups ? { for k, v in local.role_members : k => v if !contains(["Admin", "User"], v.role) } : {}
  app_role_id         = local.dashboard_roles[each.value.role].id
  principal_object_id = each.value.member
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
