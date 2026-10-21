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

## Who can run it

- `Contributor` on the subscription for the app itself.
- `Owner`, `User Access Administrator` or `Role Based Access Control Administrator` on each `shared_spn_access` scope.
- Entra: `Application Administrator` (app registration), and `Privileged Role Administrator` or Global
  Administrator for the Graph permissions. Set `grant_graph_permissions = false` if you do not have that role
  and ask an admin to grant them later.
- azurerm 5 registers no resource providers by itself. The root provider block registers `Microsoft.Web`,
  `Microsoft.Storage` and `Microsoft.ManagedIdentity`, which needs rights on the subscription; if they are already
  registered and you lack those rights, remove `resource_providers_to_register` from `versions.tf`.

## When you may not create app registrations

Some tenants hand out app registrations only through a request process. Then:

1. Set `create_sso_app = false` (and an `admin_password` so you can get in meanwhile) and apply. This builds the
   web app and the user-assigned identity, with SSO off.
2. Run `terraform output -raw sso_app_request` and send that text to the team. It lists the redirect URI, the two
   app roles, "assignment required", and the federated credential (issuer, subject = the identity's object ID,
   audience), so no secret is needed.
3. Put the client ID they send back in `sso_app_client_id` (and `sso_client_secret` only if they gave a secret
   instead of the federated credential) and apply again. The team assigns people to Admin/User.

Granting the Graph permissions to the shared SPN is a separate Entra admin action (Privileged Role
Administrator); if that is also done by request, set `grant_graph_permissions = false` and ask for
`User.Read.All`, `GroupMember.Read.All`, `Application.Read.All` and `EntitlementManagement.Read.All` as
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
  source = "github.com/Gooseankles/azure-ops-dashboard//infra/terraform/modules/dashboard?ref=v0.8.0.1"

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
as `:0.8.0.1` to pin the app too. Inputs are in `modules/dashboard/variables.tf`, outputs
(`url`, `web_app_id`, `web_app_principal_id`, `shared_spn_role_assignments`, `resource_group_name`, the SSO values,
`history_storage_url`) in `modules/dashboard/outputs.tf`.

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
- Subscription creation and decommission need billing rights; give those to a separate identity and set it as
  that tool's SPN override in Settings.
- A web app you already built by hand is not adopted; either `terraform import` it or let Terraform create a
  new one with another `name`.
