# Terraform setup

The deployment is a module, `modules/dashboard`. This folder is a ready-made root configuration that calls it;
you can also call the module from your own configuration (see [Use the module](#use-the-module)).
It needs Terraform 1.6 or newer and azurerm 5.x (azuread 3.x, random 3.x).

One `apply` creates:

- Resource group, Linux App Service plan (B1) and the web app running `trozity/azure-ops-dashboard:latest`
  (port 7070, `/home/data` storage, Always On, HTTPS only, random session secret).
- **Shared SPN**: the web app's system-assigned identity, used by every tool that has no SPN override in Settings.
  `shared_spn_access` says where it gets access and with which roles (default Reader, Cost Management Reader and Key Vault Reader,
  which is all the scans need), plus the Microsoft Graph application permissions the tools use.
- **Secretless SSO**: an Entra app registration with the Admin and User roles, "assignment required" on, a
  user-assigned identity attached to the web app, and a federated credential so no client secret exists.
- Role assignments for the users or groups in `admin_principal_ids` and `user_principal_ids`.
- **History storage** (`create_history_storage`, on by default): a storage account with account keys off, a private
  `dashboard` container, and Storage Blob Data Contributor for the web app's identity. Every scan run is kept there
  (`history_retention_days`, default 730), so the dashboard shows trends and what was new or resolved in each run.
  Off = results stay on the app's own disk (`/home/data`, 365 days by default).
- **Secret vault** (`create_secret_vault`, on by default): a key vault (RBAC, soft delete 90 days) for the client
  secrets entered in Settings (SPN overrides, customer tenants). The web app gets Key Vault Secrets Officer on it and
  reads and writes it with its managed identity; Terraform never writes a secret, so none reach the state. Add
  object IDs to `secret_vault_admin_ids` for people who may see the secrets in the portal. Purge protection is off
  by default (`secret_vault_purge_protection`), so a deleted deployment can reuse the name.

Every identity's permissions, including the app registration each customer makes in their own tenant, are listed in
[docs/permissions.md](../../docs/permissions.md).

## Shared SPN access

Each entry is a scope and, optionally, its roles:

```hcl
shared_spn_access = [
  # Whole tenant (the tenant root management group's ID is the tenant ID), default roles.
  { scope = "/providers/Microsoft.Management/managementGroups/<tenant-id>" },
  # One subscription only, without Key Vault item checks.
  { scope = "/subscriptions/<id>", roles = ["Reader", "Cost Management Reader"] },
]

# Optional: scan only these subscriptions (blank = every subscription the shared SPN can see).
scan_subscription_ids = ["<id>"]
```

The `shared_spn_role_assignments` output lists what was granted. The old `scan_scopes` list still works (each
entry becomes a scope with the default roles) but is deprecated; move it to `shared_spn_access`.

## Access restrictions

To let only some networks reach the site (the portal's "Enabled from selected virtual networks and IP addresses"):

```hcl
allowed_ip_ranges  = ["203.0.113.10", "198.51.100.0/24"]  # office / VPN egress IPs; a bare IP = that one address
allowed_subnet_ids = []                                   # optional: subnets with the Microsoft.Web service endpoint
```

Any entry turns the default action to Deny, so every other address gets a 403 from App Service before it reaches
the app. The Kudu (scm) site follows the same rules. Sign-in keeps working because the Entra redirect goes through
the user's own browser. Empty lists (the default) leave the site open to the internet, with sign-in still required.

## Customer tenants

```hcl
customers = {
  acme = {
    name             = "Acme AS"
    tenant_id        = "00000000-0000-0000-0000-000000000000"
    client_id        = ""                   # the app registration made in Acme's tenant (set it once it exists)
    subscription_ids = []                   # empty = every subscription that app can see there
    admin_members    = ["<user object id>"] # Admin-acme: read and run Acme's scans
    user_members     = ["<user object id>"] # User-acme: read Acme only
  }
}
```

Each key (lowercase letters, digits, - or _) names the app roles `Admin-<key>` and `User-<key>`, the role groups
and the storage container `dashboard-<key>`. With at least one customer, Terraform adds:

- a storage container per customer.

In each customer tenant, by hand: register an app, give it a client secret, the Graph application permissions with
admin consent and Reader, Cost Management Reader and Key Vault Reader ([details](../../docs/permissions.md#customer-tenant-app-other-tenants)).
Set its `client_id` and apply again (or enter it in Settings), and paste the secret in the dashboard's Settings →
Customer tenants → Edit. The secret goes to the secret vault and is never a Terraform value, so it stays out of
the state. `terraform output customer_onboarding` prints the steps and
the `az role assignment create` commands per customer. So the first apply can run before the app registrations
exist.

A customer's own app cannot trust the dashboard's managed identity instead of a secret: Entra refuses a managed
identity of another tenant in a federated credential (AADSTS700236).

**Upgrading from 0.11.0.x / 0.11.1.0:** the shared multi-tenant scan app (0.11.0.0) and the managed identity
`id-<name>-customers` (0.11.0.1) are gone; the next apply deletes them. Federated credentials added to customer
apps for that identity can be deleted; give each app a client secret instead.

## Role groups

With `create_role_groups = true` (the default), every role (Admin, User, Admin-&lt;key&gt;, User-&lt;key&gt;) gets an
Entra security group assigned to that app role; `admin_principal_ids`, `user_principal_ids` and each customer's
`admin_members` / `user_members` become members. Later, add people to the groups (`role_groups` output) in Entra;
one person can be in several customers' groups. Assigning groups to app roles needs Entra ID P1 or P2. Set it to
`false` to assign people to the roles directly, as before 0.11.

**Upgrading:** with groups on, the direct Admin/User assignments of an earlier deployment are replaced by the
groups (same people). Whoever runs Terraform then also needs to create groups (Groups Administrator, or
`Group.ReadWrite.All`).

## Private network

```hcl
private_network    = true
vnet_address_space = ["10.90.0.0/24"]  # a VNet is created: /26 for the app, /27 for private endpoints
```

The web app gets outbound VNet integration and reaches the history storage account and the secret vault through
private endpoints (with `privatelink.blob.core.windows.net` and `privatelink.vaultcore.azure.net` private DNS zones
linked to the VNet), and their public network access is turned off. To use an existing network instead, set
`vnet_integration_subnet_id` (delegated to `Microsoft.Web/serverFarms`), `private_endpoint_subnet_id` and, if the
DNS zones live in a hub, `blob_private_dns_zone_id` and `vault_private_dns_zone_id`. `vnet_route_all = true` sends all outbound traffic through the VNet (it then needs a
NAT gateway or firewall for internet access). The App Service plan must support VNet integration (Basic or higher).
Terraform creates the containers through the storage data plane, so run it from a network that can reach the
private endpoint, or apply once with `private_network = false` first so the containers exist.

## Who can run it

(All in one table in [docs/permissions.md](../../docs/permissions.md#whoever-runs-terraform).)

- `Contributor` on the subscription for the app itself.
- `Owner`, `User Access Administrator` or `Role Based Access Control Administrator` on each `shared_spn_access` scope,
  and on the dashboard's resource group (the storage account and secret vault role assignments).
- Entra: `Application Administrator` (app registration), and `Privileged Role Administrator` or Global
  Administrator for the Graph permissions. Set `grant_graph_permissions = false` if you do not have that role
  and ask an admin to grant them later. With `create_role_groups` (the default) also `Groups Administrator`.
  `grant_sso_consent` (default true) grants admin consent for sign-in (openid, profile). A pipeline service
  principal needs the Microsoft Graph application permission `DelegatedPermissionGrant.ReadWrite.All` (admin
  consented) for it; a person needs Application Administrator or Global Administrator. With `false`, an admin clicks
  "Grant admin consent" under Enterprise applications → the app → Permissions, or users in tenants that block
  user consent see "Need admin approval".
- `Network Contributor` (on the subscription, or on the existing VNet) when `private_network = true`.
- azurerm 5 registers no resource providers by itself. The root provider block registers `Microsoft.Web`,
  `Microsoft.Storage`, `Microsoft.ManagedIdentity` and `Microsoft.KeyVault`, which needs rights on the subscription; if they are already
  registered and you lack those rights, remove `resource_providers_to_register` from `versions.tf`.

## Where to find what Terraform made in Entra

| What | Where in the portal |
| --- | --- |
| Sign-in app (roles, redirect URI, federated credential) | App registrations → **Azure tools dashboard (&lt;name&gt;)** |
| Scan identity (the shared SPN) and its Graph permissions | Enterprise applications → set **Application type = Managed Identities** → **&lt;name&gt;** (the web app's name) → Permissions |
| Sign-in identity (trusted by the sign-in app, no permissions) | Enterprise applications → Managed Identities → **id-&lt;name&gt;-sso** |

The scan identity is the web app's system-assigned managed identity. A managed identity has no app registration,
so it is only under Enterprise applications, and the default filter there (Enterprise Applications) hides it. Its
object ID is the `web_app_principal_id` output; its Azure roles are on each `shared_spn_access` scope under Access
control (IAM).

## When you may not create app registrations

Some tenants hand out app registrations only through a request process. Then:

1. Set `create_sso_app = false` (and an `admin_password` so you can get in meanwhile) and apply. This builds the
   web app and the user-assigned identity, with SSO off.
2. Run `terraform output -raw sso_app_request` and send that text to the team. It lists the redirect URI, the
   app roles (Admin, User and a pair per customer), "assignment required", and the federated credential (issuer, subject = the identity's object ID,
   audience), so no secret is needed.
3. Put the client ID they send back in `sso_app_client_id` (and `sso_client_secret` only if they gave a secret
   instead of the federated credential) and apply again. The team assigns people to Admin/User.

Granting the Graph permissions to the shared SPN is a separate Entra admin action (Privileged Role
Administrator); if that is also done by request, set `grant_graph_permissions = false` and ask for
`User.Read.All`, `GroupMember.Read.All`, `Application.Read.All`, `EntitlementManagement.Read.All`,
`RoleManagement.Read.Directory`, `AuditLog.Read.All`, `Policy.Read.All`, `DelegatedPermissionGrant.Read.All`,
`LicenseAssignment.Read.All`, `PrivilegedEligibilitySchedule.Read.AzureADGroup` and
`PrivilegedAssignmentSchedule.Read.AzureADGroup` as
application permissions for the `web_app_principal_id` output.

## Run

```
cd infra/terraform
copy terraform.tfvars.example terraform.tfvars   # then fill it in
az login
terraform init
terraform plan
terraform apply
```

Open the `url` output and sign in. State is local by default; for a team, add an `azurerm` backend
(storage account) to `versions.tf`.

**Upgrading an existing deployment** (from before the module): run `terraform init -upgrade`, then `plan`. The
`moved` blocks in `main.tf` carry the resources over to `module.dashboard`, so the plan should show moves and
no replacements.

**Upgrading to 0.12:** the apply adds the secret vault and its role assignment (register `Microsoft.KeyVault` if
your runner cannot). On its first start the app moves the client secrets it finds in `settings.json` and
`tenants.json` into the vault and removes them from the files; nothing has to be re-entered.

## Use the module

The module has no provider blocks; pass your own. The azurerm provider needs `storage_use_azuread = true` when
`create_history_storage` is on.

```hcl
provider "azurerm" {
  features {}
  subscription_id     = "<id>"
  storage_use_azuread = true
}

module "dashboard" {
  source = "github.com/Gooseankles/azure-ops-dashboard//infra/terraform/modules/dashboard?ref=v0.19.5.0"

  name     = "contoso-azure-tools"
  location = "norwayeast"

  shared_spn_access = [
    { scope = "/providers/Microsoft.Management/managementGroups/<tenant-id>" },
  ]
  admin_principal_ids = ["<group object id>"]
}

output "url" {
  value = module.dashboard.url
}
```

`?ref=` picks the module version. Every version has a git tag `v<version>` (see the repo's tags), so pin one and
raise it when you choose to upgrade; `?ref=main` follows every push. The tag pins the infrastructure only: the app
image is the `image` input (default `trozity/azure-ops-dashboard:latest`), so set it to `:stable` or a version such
as `:0.19.5.0` to pin the app too. Inputs are in `modules/dashboard/variables.tf`, outputs
(`url`, `web_app_id`, `web_app_principal_id`, `shared_spn_role_assignments`, `resource_group_name`, the SSO values,
`history_storage_url`, `secret_vault_uri`, `role_groups`, `customer_onboarding`, `customer_containers` and
`private_network`) in `modules/dashboard/outputs.tf`.

## Policy check

Needs nothing beyond Reader on the shared SPN's scopes: it reads assignments, definitions, compliance states,
exemptions, remediation tasks and the policy identities' role assignments, and its probes call
`checkPolicyRestrictions` (a read operation; no resource is created). Choose the probes in Settings, Policy check.

## Key Vault

Key Vault Reader (in the default roles) lets the Key Vault tool list secrets, keys and certificates with their
expiry dates on RBAC vaults; it can never read a secret's value. Vaults still on access policies need a policy
for `web_app_principal_id` with **list** on secrets, keys and certificates. A vault whose firewall does not let the
App Service in shows up as "Items not checked".

## Not covered

- Key Vault access policies on access-policy vaults (see above).
- A web app you already built by hand is not adopted; either `terraform import` it or let Terraform create a
  new one with another `name`.
