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

variable "shared_spn_access" {
  description = <<-EOT
    Where the shared SPN (the web app's system-assigned identity, used by every tool without its own SPN
    override) gets access, and with which Azure roles. Each entry is a scope: a management group
    ("/providers/Microsoft.Management/managementGroups/<id>"; the tenant root group's ID is the tenant ID), a
    subscription ("/subscriptions/<id>"), a resource group or a single resource such as a Key Vault. roles
    defaults to Reader + Cost Management Reader, which is what the scans need. Empty list = no role
    assignments (grant them yourself).
  EOT
  type = list(object({
    scope = string
    roles = optional(list(string), ["Reader", "Cost Management Reader"])
  }))
  default = []

  validation {
    condition     = alltrue([for a in var.shared_spn_access : startswith(a.scope, "/")])
    error_message = "Each shared_spn_access scope must be a full resource ID starting with \"/\", e.g. /subscriptions/<id> or /providers/Microsoft.Management/managementGroups/<id>."
  }
}

variable "scan_subscription_ids" {
  description = "Limit the scans to these subscription IDs (AZURE_SUBSCRIPTION_IDS). Empty = every subscription the shared SPN can see, so new subscriptions under shared_spn_access are picked up automatically."
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

variable "create_history_storage" {
  description = "Create a storage account for scan results and run history (reached with the web app's managed identity, no keys). false = keep them on the app's own disk."
  type        = bool
  default     = true
}

variable "storage_account_name" {
  description = "Storage account name (3-24 lowercase letters and digits, globally unique). Blank = st<name without dashes> plus a random suffix."
  type        = string
  default     = ""
}

variable "history_retention_days" {
  description = "How many days of run history the dashboard keeps."
  type        = number
  default     = 730
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
