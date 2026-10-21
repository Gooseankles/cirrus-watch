# --- Secrets typed into Settings (create_secret_vault) ---
#
# A key vault for the client secrets entered on the Settings page (SPN
# overrides, customer tenants), so they are not kept on the app's disk. The web
# app reads and writes them with its system-assigned identity, which gets Key
# Vault Secrets Officer on this vault only. Terraform itself never writes a
# secret here, so it needs no access to the vault's data.

locals {
  secret_vault_name = var.secret_vault_name != "" ? var.secret_vault_name : substr("kv${replace(lower(var.name), "/[^a-z0-9]/", "")}${random_string.storage_suffix.result}", 0, 24)
}

resource "azurerm_key_vault" "secrets" {
  count                      = var.create_secret_vault ? 1 : 0
  name                       = local.secret_vault_name
  resource_group_name        = azurerm_resource_group.this.name
  location                   = azurerm_resource_group.this.location
  tenant_id                  = data.azuread_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  soft_delete_retention_days = 90
  purge_protection_enabled   = var.secret_vault_purge_protection
  # private_network: only the private endpoint reaches it.
  public_network_access_enabled = !var.private_network
  tags                          = var.tags

  network_acls {
    default_action = var.private_network ? "Deny" : "Allow"
    bypass         = "AzureServices"
  }
}

resource "azurerm_role_assignment" "secrets_app" {
  count                = var.create_secret_vault ? 1 : 0
  scope                = azurerm_key_vault.secrets[0].id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = azurerm_linux_web_app.this.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# People or groups who may see and change the stored secrets in the portal
# (break-glass); nobody else can read them.
resource "azurerm_role_assignment" "secrets_admins" {
  for_each             = var.create_secret_vault ? toset(var.secret_vault_admin_ids) : toset([])
  scope                = azurerm_key_vault.secrets[0].id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
}
