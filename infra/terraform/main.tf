# Deploys the dashboard with the module in modules/dashboard. To use the module
# from another configuration instead:
#   source = "github.com/Gooseankles/azure-ops-dashboard//infra/terraform/modules/dashboard?ref=v0.9.0.0"
module "dashboard" {
  source = "./modules/dashboard"

  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku_name            = var.sku_name
  image               = var.image
  shared_spn_access = concat(
    var.shared_spn_access,
    [for s in var.scan_scopes : { scope = s, roles = ["Reader", "Cost Management Reader", "Key Vault Reader"] }],
  )
  scan_subscription_ids   = var.scan_subscription_ids
  grant_graph_permissions = var.grant_graph_permissions
  graph_permissions       = var.graph_permissions
  create_history_storage  = var.create_history_storage
  storage_account_name    = var.storage_account_name
  history_retention_days  = var.history_retention_days
  create_sso_app          = var.create_sso_app
  sso_app_client_id       = var.sso_app_client_id
  sso_client_secret       = var.sso_client_secret
  admin_principal_ids     = var.admin_principal_ids
  user_principal_ids      = var.user_principal_ids
  admin_password          = var.admin_password
  extra_app_settings      = var.extra_app_settings
  tags                    = var.tags
}

# The resources lived in this folder before it became a module; these keep an
# existing deployment's state instead of rebuilding it.
moved {
  from = azurerm_resource_group.this
  to   = module.dashboard.azurerm_resource_group.this
}
moved {
  from = azurerm_user_assigned_identity.sso
  to   = module.dashboard.azurerm_user_assigned_identity.sso
}
moved {
  from = azurerm_service_plan.this
  to   = module.dashboard.azurerm_service_plan.this
}
moved {
  from = random_password.session_secret
  to   = module.dashboard.random_password.session_secret
}
moved {
  from = azurerm_linux_web_app.this
  to   = module.dashboard.azurerm_linux_web_app.this
}
moved {
  from = random_string.storage_suffix
  to   = module.dashboard.random_string.storage_suffix
}
moved {
  from = azurerm_storage_account.history
  to   = module.dashboard.azurerm_storage_account.history
}
moved {
  from = azurerm_storage_container.history
  to   = module.dashboard.azurerm_storage_container.history
}
moved {
  from = azurerm_role_assignment.history_app
  to   = module.dashboard.azurerm_role_assignment.history_app
}
moved {
  from = azurerm_role_assignment.scan
  to   = module.dashboard.azurerm_role_assignment.scan
}
moved {
  from = random_uuid.role_admin
  to   = module.dashboard.random_uuid.role_admin
}
moved {
  from = random_uuid.role_user
  to   = module.dashboard.random_uuid.role_user
}
moved {
  from = azuread_application.dashboard
  to   = module.dashboard.azuread_application.dashboard
}
moved {
  from = azuread_service_principal.dashboard
  to   = module.dashboard.azuread_service_principal.dashboard
}
moved {
  from = azuread_application_federated_identity_credential.sso
  to   = module.dashboard.azuread_application_federated_identity_credential.sso
}
moved {
  from = azuread_app_role_assignment.admins
  to   = module.dashboard.azuread_app_role_assignment.admins
}
moved {
  from = azuread_app_role_assignment.users
  to   = module.dashboard.azuread_app_role_assignment.users
}
moved {
  from = azuread_app_role_assignment.graph
  to   = module.dashboard.azuread_app_role_assignment.graph
}
