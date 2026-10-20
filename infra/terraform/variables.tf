variable "subscription_id" {
  description = "Subscription the dashboard itself (resource group, plan, web app) is created in."
  type        = string
}

variable "name" {
  description = "Web app name; must be globally unique. The site becomes https://<name>.azurewebsites.net."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "norwayeast"
}

variable "resource_group_name" {
  description = "Resource group to create. Blank = rg-<name>."
  type        = string
  default     = ""
}

variable "sku_name" {
  description = "App Service plan size. B1 is enough; Always On needs Basic or higher."
  type        = string
  default     = "B1"
}

variable "image" {
  description = "Docker Hub image and tag."
  type        = string
  default     = "trozity/azure-ops-dashboard:latest"
}

variable "scan_scopes" {
  description = <<-EOT
    Scopes the app's system-assigned identity gets Reader and Cost Management Reader on, so the scan tools
    see every subscription below them. Use management groups, e.g.
    "/providers/Microsoft.Management/managementGroups/<tenant-id>" for the tenant root group.
    Empty = no role assignments (grant them yourself).
  EOT
  type        = list(string)
  default     = []
}

variable "grant_graph_permissions" {
  description = <<-EOT
    Give the system-assigned identity the Microsoft Graph application permissions the tools use (user and group
    names, group members, app registration secrets, access packages). Needs a Privileged Role Administrator or
    Global Administrator running terraform.
  EOT
  type        = bool
  default     = true
}

variable "graph_permissions" {
  description = "Microsoft Graph application permissions for the system-assigned identity."
  type        = list(string)
  default = [
    "User.Read.All",
    "GroupMember.Read.All",
    "Application.Read.All",
    "EntitlementManagement.Read.All",
  ]
}

variable "admin_principal_ids" {
  description = "Object IDs of users or groups that get the Admin role on the dashboard."
  type        = list(string)
  default     = []
}

variable "user_principal_ids" {
  description = "Object IDs of users or groups that get the read-only User role on the dashboard."
  type        = list(string)
  default     = []
}

variable "admin_password" {
  description = "Break-glass local login (username admin). Blank = disabled (recommended once SSO works)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "extra_app_settings" {
  description = "Extra app settings, e.g. WEBHOOK_SHARED_SECRET, SNOW_INSTANCE_URL, AZURE_REQUIRED_TAGS."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "tags" {
  description = "Tags on the Azure resources."
  type        = map(string)
  default     = {}
}
