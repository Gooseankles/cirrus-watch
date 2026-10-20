locals {
  resource_group_name = var.resource_group_name != "" ? var.resource_group_name : "rg-${var.name}"
  site_url            = "https://${var.name}.azurewebsites.net"
  redirect_uri        = "${local.site_url}/auth/callback"

  image_parts = split(":", var.image)
  image_name  = local.image_parts[0]
  image_tag   = length(local.image_parts) > 1 ? local.image_parts[1] : "latest"
}

data "azuread_client_config" "current" {}

resource "azurerm_resource_group" "this" {
  name     = local.resource_group_name
  location = var.location
  tags     = var.tags
}

# Used only for SSO: the sign-in app registration trusts it through a
# federated credential, so no client secret exists anywhere.
resource "azurerm_user_assigned_identity" "sso" {
  name                = "id-${var.name}-sso"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = var.tags
}

resource "azurerm_service_plan" "this" {
  name                = "asp-${var.name}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  os_type             = "Linux"
  sku_name            = var.sku_name
  tags                = var.tags
}

resource "random_password" "session_secret" {
  length  = 48
  special = false
}

resource "azurerm_linux_web_app" "this" {
  name                = var.name
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  service_plan_id     = azurerm_service_plan.this.id
  https_only          = true
  tags                = var.tags

  # System-assigned: the scan tools (blank client ID in Settings).
  # User-assigned: SSO only.
  identity {
    type         = "SystemAssigned, UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.sso.id]
  }

  site_config {
    always_on           = true
    ftps_state          = "Disabled"
    minimum_tls_version = "1.2"
    http2_enabled       = true

    application_stack {
      docker_registry_url = "https://index.docker.io"
      docker_image_name   = "${local.image_name}:${local.image_tag}"
    }
  }

  app_settings = merge(
    {
      WEBSITES_PORT                       = "7070"
      WEBSITES_ENABLE_APP_SERVICE_STORAGE = "true"
      DATA_DIR                            = "/home/data"
      SESSION_SECRET                      = random_password.session_secret.result
      AZURE_AUTH_TYPE                     = "managed-identity"
      DASHBOARD_AZURE_TENANT_ID           = data.azuread_client_config.current.tenant_id
      DASHBOARD_AZURE_CLIENT_ID           = local.sso_client_id
      DASHBOARD_REDIRECT_URI              = local.redirect_uri
    },
    local.sso_secretless
    ? { DASHBOARD_FEDERATED_MI_CLIENT_ID = azurerm_user_assigned_identity.sso.client_id }
    : { DASHBOARD_AZURE_CLIENT_SECRET = var.sso_client_secret },
    var.admin_password != "" ? { DASHBOARD_ADMIN_PASSWORD = var.admin_password } : {},
    var.extra_app_settings,
  )

  logs {
    http_logs {
      file_system {
        retention_in_days = 7
        retention_in_mb   = 35
      }
    }
  }
}

# --- Scan permissions (ARM) ---

locals {
  scan_role_assignments = {
    for pair in setproduct(var.scan_scopes, ["Reader", "Cost Management Reader"]) :
    "${pair[0]}|${pair[1]}" => { scope = pair[0], role = pair[1] }
  }
}

resource "azurerm_role_assignment" "scan" {
  for_each             = local.scan_role_assignments
  scope                = each.value.scope
  role_definition_name = each.value.role
  principal_id         = azurerm_linux_web_app.this.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}
