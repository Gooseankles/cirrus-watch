# --- Customer tenants ---
#
# Each customer tenant gets an app registration there, made by hand, with a
# federated credential that trusts the web app's customer-scan managed identity
# below, so no secret exists (output customer_onboarding has the values).
# Nothing here touches a customer tenant.

locals {
  has_customers        = length(var.customers) > 0
  customer_fic_subject = local.has_customers ? azurerm_user_assigned_identity.customers[0].principal_id : ""

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

# Used only to sign in to customer tenants (as their app registrations), so
# sign-in logs there show this identity and nothing else.
resource "azurerm_user_assigned_identity" "customers" {
  count               = local.has_customers ? 1 : 0
  name                = "id-${var.name}-customers"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = var.tags
}


# --- Per-customer storage containers ---

resource "azurerm_storage_container" "customer" {
  for_each              = var.create_history_storage ? local.customer_containers : {}
  name                  = each.value
  storage_account_id    = azurerm_storage_account.history[0].id
  container_access_type = "private"
}
