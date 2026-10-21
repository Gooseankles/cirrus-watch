# --- Customer tenants ---
#
# One multi-tenant app registration ("scan app") scans every customer tenant.
# It has no secret: it trusts the web app's customer-scan managed identity
# through a federated credential. Each customer's admin consents to it once and
# grants it read roles by hand (output customer_onboarding); nothing here
# touches a customer tenant.

locals {
  has_customers               = length(var.customers) > 0
  customer_scan_app_created   = var.create_customer_scan_app && local.has_customers
  customer_scan_app_client_id = local.customer_scan_app_created ? azuread_application.customer_scan[0].client_id : var.customer_scan_app_client_id
  customer_fic_subject        = local.has_customers ? azurerm_user_assigned_identity.customers[0].principal_id : ""

  # What the app reads from DASHBOARD_TENANTS.
  dashboard_tenants = [
    for k, c in var.customers : merge(
      { key = k, name = c.name, tenantId = c.tenant_id, subscriptionIds = c.subscription_ids, enabled = c.enabled },
      c.client_id != "" ? { clientId = c.client_id } : {},
    )
  ]

  # The container the app uses for a customer: <base>-<key> within the blob
  # naming rules (findingsStore.containerName builds the same name).
  customer_containers = {
    for k, c in var.customers : k => replace(substr(replace(replace(lower("dashboard-${k}"), "/[^a-z0-9-]/", "-"), "/-+/", "-"), 0, 63), "/-+$/", "")
  }

  scan_roles = ["Reader", "Cost Management Reader", "Key Vault Reader"]
}

# Used only to sign in to customer tenants (as the scan app), so sign-in logs
# there show this identity and nothing else.
resource "azurerm_user_assigned_identity" "customers" {
  count               = local.has_customers ? 1 : 0
  name                = "id-${var.name}-customers"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = var.tags
}

resource "azuread_application" "customer_scan" {
  count            = local.customer_scan_app_created ? 1 : 0
  display_name     = "Azure tools dashboard scanner (${var.name})"
  sign_in_audience = "AzureADMultipleOrgs"
  owners           = [data.azuread_client_config.current.object_id]

  # Graph application permissions the scans use; each customer's admin
  # consents to them (Azure roles are granted separately).
  required_resource_access {
    resource_app_id = "00000003-0000-0000-c000-000000000000"
    dynamic "resource_access" {
      for_each = var.graph_permissions
      content {
        id   = data.azuread_service_principal.msgraph[0].app_role_ids[resource_access.value]
        type = "Role"
      }
    }
  }
}

resource "azuread_application_federated_identity_credential" "customer_scan" {
  count          = local.customer_scan_app_created ? 1 : 0
  application_id = azuread_application.customer_scan[0].id
  display_name   = "app-service-${var.name}-customers"
  description    = "Customer-scan identity of the dashboard web app"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = local.sso_fic_issuer
  subject        = local.customer_fic_subject
}

# --- Per-customer storage containers ---

resource "azurerm_storage_container" "customer" {
  for_each              = var.create_history_storage ? local.customer_containers : {}
  name                  = each.value
  storage_account_id    = azurerm_storage_account.history[0].id
  container_access_type = "private"
}
