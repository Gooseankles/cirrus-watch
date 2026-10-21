# --- Customer tenants ---
#
# Each customer tenant gets an app registration there, made by hand, with a
# client secret that is entered in the dashboard's Settings (never here, so it
# is not in the Terraform state). Output customer_onboarding has the steps.
# Nothing here touches a customer tenant.

locals {
  has_customers = length(var.customers) > 0

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


# --- Per-customer storage containers ---

resource "azurerm_storage_container" "customer" {
  for_each              = var.create_history_storage ? local.customer_containers : {}
  name                  = each.value
  storage_account_id    = azurerm_storage_account.history[0].id
  container_access_type = "private"
}
