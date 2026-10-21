terraform {
  required_version = ">= 1.6"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
  # The history storage account has account keys turned off.
  storage_use_azuread = true
  # azurerm 5 registers no resource providers by default; these are the ones
  # the module uses (registering needs rights on the subscription; remove the
  # line if they are registered already and you lack those rights).
  resource_providers_to_register = [
    "Microsoft.Web",
    "Microsoft.Storage",
    "Microsoft.ManagedIdentity",
  ]
}

provider "azuread" {}
