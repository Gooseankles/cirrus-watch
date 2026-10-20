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

variable "create_sso_app" {
  description = <<-EOT
    true = Terraform creates the sign-in app registration. false = the app registration comes from your own
    request process: set sso_app_client_id (and sso_client_secret if the team hands out a secret instead of adding
    the federated credential); the output sso_app_request lists everything to ask them for.
  EOT
  type        = bool
  default     = true
}

variable "sso_app_client_id" {
  description = "Client ID of an existing sign-in app registration (only with create_sso_app = false). Blank on the first apply: SSO stays off (use admin_password) until the team sends it."
  type        = string
  default     = ""
}

variable "sso_client_secret" {
  description = "Client secret of the existing app registration, if the team will not add the federated credential. Blank = secretless."
  type        = string
  default     = ""
  sensitive   = true
}

variable "admin_principal_ids" {
  description = "Object IDs of users or groups that get the Admin role on the dashboard (only with create_sso_app = true; otherwise the app team assigns them)."
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
