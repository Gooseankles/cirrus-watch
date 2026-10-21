# --- Private network (private_network = true) ---
#
# The web app joins a VNet (outbound VNet integration) and reaches the history
# storage account through a private endpoint, so the account's public network
# access is off. Either a VNet is created here (vnet_address_space) or existing
# subnets are used (vnet_integration_subnet_id + private_endpoint_subnet_id).

locals {
  history_private = var.private_network && var.create_history_storage
  create_vnet     = var.private_network && var.vnet_integration_subnet_id == ""

  app_subnet_id = !var.private_network ? null : (local.create_vnet ? azurerm_subnet.app[0].id : var.vnet_integration_subnet_id)
  pe_subnet_id = !local.history_private ? null : (
    var.private_endpoint_subnet_id != "" ? var.private_endpoint_subnet_id : (local.create_vnet ? azurerm_subnet.private_endpoints[0].id : null)
  )

  # The VNet the private DNS zone is linked to: the created one, or the one
  # the integration subnet belongs to.
  vnet_id           = !var.private_network ? null : (local.create_vnet ? azurerm_virtual_network.this[0].id : regex("^(.*)/subnets/[^/]+$", var.vnet_integration_subnet_id)[0])
  create_dns_zone   = local.history_private && var.blob_private_dns_zone_id == ""
  blob_dns_zone_ids = !local.history_private ? [] : (local.create_dns_zone ? [azurerm_private_dns_zone.blob[0].id] : [var.blob_private_dns_zone_id])
}

resource "azurerm_virtual_network" "this" {
  count               = local.create_vnet ? 1 : 0
  name                = "vnet-${var.name}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  address_space       = var.vnet_address_space
  tags                = var.tags
}

# Outbound VNet integration of the web app (delegated to App Service).
resource "azurerm_subnet" "app" {
  count                = local.create_vnet ? 1 : 0
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this[0].name
  address_prefixes     = [cidrsubnet(var.vnet_address_space[0], 2, 0)]

  delegation {
    name = "app-service"
    service_delegation {
      name    = "Microsoft.Web/serverFarms"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

resource "azurerm_subnet" "private_endpoints" {
  count                = local.create_vnet && var.private_endpoint_subnet_id == "" ? 1 : 0
  name                 = "snet-private-endpoints"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this[0].name
  address_prefixes     = [cidrsubnet(var.vnet_address_space[0], 3, 2)]
}

resource "azurerm_private_dns_zone" "blob" {
  count               = local.create_dns_zone ? 1 : 0
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  count                = local.create_dns_zone ? 1 : 0
  name                 = "link-${var.name}"
  private_dns_zone_id  = azurerm_private_dns_zone.blob[0].id
  virtual_network_id   = local.vnet_id
  registration_enabled = false
  tags                 = var.tags
}

resource "azurerm_private_endpoint" "history_blob" {
  count               = local.history_private ? 1 : 0
  name                = "pe-${local.storage_account_name}-blob"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  subnet_id           = local.pe_subnet_id
  tags                = var.tags

  lifecycle {
    precondition {
      condition     = local.pe_subnet_id != null
      error_message = "With vnet_integration_subnet_id set, also set private_endpoint_subnet_id."
    }
  }

  private_service_connection {
    name                           = "blob"
    private_connection_resource_id = azurerm_storage_account.history[0].id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = local.blob_dns_zone_ids
  }
}
