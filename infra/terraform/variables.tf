variable "subscription_id" {
  description = "Subscription the dashboard itself (resource group, plan, web app) is created in."
  type        = string
}

variable "scan_scopes" {
  description = "Old name, kept so existing tfvars keep working: each scope gets Reader, Cost Management Reader and Key Vault Reader, same as a shared_spn_access entry without roles. Use shared_spn_access instead."
  type        = list(string)
  default     = []
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

variable "shared_spn_access" {
  description = <<-EOT
    Where the shared SPN (the web app's system-assigned identity, used by every tool without its own SPN
    override) gets access, and with which Azure roles. Each entry is a scope: a management group
    ("/providers/Microsoft.Management/managementGroups/<id>"; the tenant root group's ID is the tenant ID), a
    subscription ("/subscriptions/<id>"), a resource group or a single resource such as a Key Vault. roles
    defaults to Reader, Cost Management Reader and Key Vault Reader, which is what the scans need. Empty list = no role
    assignments (grant them yourself).
  EOT
  type = list(object({
    scope = string
    roles = optional(list(string), ["Reader", "Cost Management Reader", "Key Vault Reader"])
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
    names, group members, app registration secrets, access packages, directory roles, sign-in activity, Conditional
    Access and consent settings, delegated consents). Needs a Privileged Role Administrator or
    Global Administrator running terraform.
  EOT
  type        = bool
  default     = true
}

variable "grant_sso_consent" {
  description = <<-EOT
    Grant tenant-wide admin consent for the sign-in app's delegated permissions (openid, profile), so tenants that
    do not let users consent themselves do not show "Need admin approval" at sign-in. Only with create_sso_app =
    true. A service principal running terraform (a pipeline) needs the Microsoft Graph application permission
    DelegatedPermissionGrant.ReadWrite.All; a person needs Application Administrator or Global Administrator.
    false = an admin clicks "Grant admin consent" on the Enterprise app's Permissions page instead.
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
    "RoleManagement.Read.Directory",
    "AuditLog.Read.All",
    "Policy.Read.All",
    "DelegatedPermissionGrant.Read.All",
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

variable "create_secret_vault" {
  description = "Create a key vault for the client secrets entered in Settings (SPN overrides, customer tenants); the web app reads and writes it with its managed identity. false = those secrets stay in files on the app's own disk."
  type        = bool
  default     = true
}

variable "secret_vault_name" {
  description = "Key vault name (3-24 letters, digits and dashes, globally unique). Blank = kv<name without dashes> plus a random suffix."
  type        = string
  default     = ""
}

variable "secret_vault_purge_protection" {
  description = "Turn on purge protection for the secret vault. Cannot be turned off again, and a deleted vault then keeps its name for 90 days."
  type        = bool
  default     = false
}

variable "secret_vault_admin_ids" {
  description = "Object IDs of users or groups who may see and change the stored secrets in the portal (Key Vault Secrets Officer). Empty = only the web app."
  type        = list(string)
  default     = []
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
  description = "Extra app settings, e.g. AZURE_REQUIRED_TAGS."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "allowed_ip_ranges" {
  description = "Public IPs or CIDR ranges that may reach the web app. Empty (with empty allowed_subnet_ids) = open to the internet."
  type        = list(string)
  default     = []
}

variable "allowed_subnet_ids" {
  description = "Subnet resource IDs that may reach the web app (needs the Microsoft.Web service endpoint on the subnet)."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags on the Azure resources."
  type        = map(string)
  default     = {}
}

# --- Customer tenants ---

variable "customers" {
  description = <<-EOT
    Customer tenants the dashboard scans besides its own, keyed by a short customer key (lowercase letters, digits,
    - or _; it names the app roles Admin-<key> and User-<key>, the Entra groups and the storage container).
      name             shown in the tenant tabs
      tenant_id        the customer's Entra tenant ID
      client_id        the app registration made in that tenant (see the customer_onboarding output). Empty until
                       it exists; it can also be set in the app's Settings. Its client secret is entered only in
                       the app's Settings, so it never lands in the Terraform state.
      subscription_ids limit the scans to these subscriptions (empty = every one the app can see there)
      enabled          false = keep the customer but stop scanning it
      admin_members    object IDs of users who get Admin-<key> (read and run scans for this customer)
      user_members     object IDs of users who get User-<key> (read this customer)
    Terraform never touches a customer tenant: the app registration and its permissions are made there by hand.
  EOT
  type = map(object({
    name             = string
    tenant_id        = string
    subscription_ids = optional(list(string), [])
    client_id        = optional(string, "")
    enabled          = optional(bool, true)
    admin_members    = optional(list(string), [])
    user_members     = optional(list(string), [])
  }))
  default = {}

  validation {
    condition     = alltrue([for k, c in var.customers : can(regex("^[a-z0-9][a-z0-9_-]{0,39}$", k)) && k != "home"])
    error_message = "Each customers key must be 1-40 lowercase letters, digits, - or _ (and not \"home\")."
  }
  validation {
    condition     = alltrue([for k, c in var.customers : can(regex("^[0-9a-fA-F-]{36}$", c.tenant_id))])
    error_message = "Each customer's tenant_id must be a GUID."
  }
}


variable "create_role_groups" {
  description = <<-EOT
    Create an Entra security group per dashboard role (Admin, User, Admin-<key>, User-<key>) and assign it to that
    app role, so people get access by group membership and can be in several customers' groups. admin_principal_ids,
    user_principal_ids and each customer's admin_members / user_members become group members. Assigning groups to app
    roles needs Microsoft Entra ID P1 or P2, and members must be users (nested groups do not count). false = assign
    the people to the roles directly.
  EOT
  type        = bool
  default     = true
}

variable "role_group_prefix" {
  description = "Display name prefix of the role groups. Blank = \"Azure tools dashboard (<name>)\"."
  type        = string
  default     = ""
}

# --- Private networking ---

variable "private_network" {
  description = <<-EOT
    Join the web app to a virtual network (VNet integration) and reach the history storage account and the secret
    vault through private endpoints, with their public network access turned off. Without existing subnets a small
    VNet is created (vnet_address_space). Costs a little extra (private endpoint and DNS zone).
  EOT
  type        = bool
  default     = false
}

variable "vnet_address_space" {
  description = "Address space of the VNet created when private_network = true and no subnets are given. A /24 is plenty: a /26 for the app and a /27 for private endpoints."
  type        = list(string)
  default     = ["10.90.0.0/24"]
}

variable "vnet_integration_subnet_id" {
  description = "Existing subnet for the web app's VNet integration (delegated to Microsoft.Web/serverFarms, /28 or larger). Set together with private_endpoint_subnet_id; blank = create a VNet."
  type        = string
  default     = ""
}

variable "private_endpoint_subnet_id" {
  description = "Existing subnet for the private endpoints (storage, secret vault). Set together with vnet_integration_subnet_id."
  type        = string
  default     = ""
}

variable "blob_private_dns_zone_id" {
  description = "Existing privatelink.blob.core.windows.net private DNS zone (e.g. in a hub), already linked to the VNet. Blank = create one and link it to the VNet."
  type        = string
  default     = ""
}

variable "vault_private_dns_zone_id" {
  description = "Existing privatelink.vaultcore.azure.net private DNS zone (e.g. in a hub), already linked to the VNet. Blank = create one and link it to the VNet."
  type        = string
  default     = ""
}

variable "vnet_route_all" {
  description = "Send all the web app's outbound traffic through the VNet (needs a NAT gateway or firewall there for internet access). false = only private addresses go through the VNet, which is all the private endpoint needs."
  type        = bool
  default     = false
}
