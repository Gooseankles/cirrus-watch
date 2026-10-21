locals {
  resource_group_name = var.resource_group_name != "" ? var.resource_group_name : "rg-${var.name}"
  site_url            = "https://${var.name}.azurewebsites.net"
  redirect_uri        = "${local.site_url}/auth/callback"

  image_parts = split(":", var.image)
  image_name  = local.image_parts[0]
  image_tag   = length(local.image_parts) > 1 ? local.image_parts[1] : "latest"

  # A bare address becomes a /32 (or /128 for IPv6).
  allowed_ip_ranges = [for ip in var.allowed_ip_ranges : strcontains(ip, "/") ? ip : (strcontains(ip, ":") ? "${ip}/128" : "${ip}/32")]
  restricted        = length(var.allowed_ip_ranges) + length(var.allowed_subnet_ids) > 0
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

  # Outbound through the VNet (private_network): reaches the history storage
  # by its private endpoint.
  virtual_network_subnet_id = local.app_subnet_id

  # System-assigned: the scan tools in the home tenant (blank client ID in
  # Settings). User-assigned: SSO.
  identity {
    type         = "SystemAssigned, UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.sso.id]
  }

  site_config {
    always_on           = true
    ftps_state          = "Disabled"
    minimum_tls_version = "1.2"
    http2_enabled       = true

    # All outbound traffic through the VNet (needs a NAT gateway or firewall
    # there to reach Docker Hub and Azure); off = only private addresses.
    vnet_route_all_enabled = var.private_network && var.vnet_route_all

    # Access restrictions: with any allowed IP or subnet, everything else is
    # refused before it reaches the app. The Kudu (scm) site follows the same rules.
    ip_restriction_default_action = local.restricted ? "Deny" : "Allow"
    scm_use_main_ip_restriction   = local.restricted

    dynamic "ip_restriction" {
      for_each = local.allowed_ip_ranges
      content {
        name       = "allow-ip-${ip_restriction.key + 1}"
        action     = "Allow"
        priority   = 100 + ip_restriction.key
        ip_address = ip_restriction.value
      }
    }

    dynamic "ip_restriction" {
      for_each = var.allowed_subnet_ids
      content {
        name                      = "allow-subnet-${ip_restriction.key + 1}"
        action                    = "Allow"
        priority                  = 200 + ip_restriction.key
        virtual_network_subnet_id = ip_restriction.value
      }
    }

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
    var.create_history_storage ? {
      STORAGE_ACCOUNT_URL    = azurerm_storage_account.history[0].primary_blob_endpoint
      STORAGE_CONTAINER      = azurerm_storage_container.history[0].name
      HISTORY_RETENTION_DAYS = tostring(var.history_retention_days)
    } : {},
    local.has_customers ? { DASHBOARD_TENANTS = jsonencode(local.dashboard_tenants) } : {},
    length(var.scan_subscription_ids) > 0 ? { AZURE_SUBSCRIPTION_IDS = join(",", var.scan_subscription_ids) } : {},
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

# --- Scan results and run history ---

resource "random_string" "storage_suffix" {
  length  = 5
  upper   = false
  special = false
}

locals {
  storage_account_name = var.storage_account_name != "" ? var.storage_account_name : substr("st${replace(lower(var.name), "/[^a-z0-9]/", "")}${random_string.storage_suffix.result}", 0, 24)
}

resource "azurerm_storage_account" "history" {
  count                           = var.create_history_storage ? 1 : 0
  name                            = local.storage_account_name
  resource_group_name             = azurerm_resource_group.this.name
  location                        = azurerm_resource_group.this.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false # Entra (managed identity) only
  default_to_oauth_authentication = true
  # private_network: only the private endpoint reaches it.
  public_network_access = var.private_network ? "Disabled" : "Enabled"
  tags                  = var.tags

  dynamic "network_rules" {
    for_each = var.private_network ? [1] : []
    content {
      default_action = "Deny"
      bypass         = ["AzureServices"]
    }
  }

  blob_properties {
    versioning_enabled = false
    delete_retention_policy {
      days = 7
    }
  }
}

resource "azurerm_storage_container" "history" {
  count                 = var.create_history_storage ? 1 : 0
  name                  = "dashboard"
  storage_account_id    = azurerm_storage_account.history[0].id
  container_access_type = "private"
}

resource "azurerm_role_assignment" "history_app" {
  count                = var.create_history_storage ? 1 : 0
  scope                = azurerm_storage_account.history[0].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_web_app.this.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# --- Shared SPN access (ARM roles) ---

locals {
  scan_role_assignments = merge([
    for a in var.shared_spn_access : {
      for role in a.roles : "${a.scope}|${role}" => { scope = a.scope, role = role }
    }
  ]...)
}

resource "azurerm_role_assignment" "scan" {
  for_each             = local.scan_role_assignments
  scope                = each.value.scope
  role_definition_name = each.value.role
  principal_id         = azurerm_linux_web_app.this.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}
