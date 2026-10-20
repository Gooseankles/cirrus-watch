# Terraform setup

Creates everything the dashboard needs in one `apply`:

- Resource group, Linux App Service plan (B1) and the web app running `trozity/azure-ops-dashboard:latest`
  (port 7070, `/home/data` storage, Always On, HTTPS only, random session secret).
- **Scan identity**: the web app's system-assigned identity, with Reader and Cost Management Reader on each
  `scan_scopes` entry (use a management group) and the Microsoft Graph application permissions the tools use.
- **Secretless SSO**: an Entra app registration with the Admin and User roles, "assignment required" on, a
  user-assigned identity attached to the web app, and a federated credential so no client secret exists.
- Role assignments for the users or groups in `admin_principal_ids` and `user_principal_ids`.

## Who can run it

- `Contributor` on the subscription for the app itself.
- `Owner` or `User Access Administrator` on each `scan_scopes` entry (for the role assignments).
- Entra: `Application Administrator` (app registration), and `Privileged Role Administrator` or Global
  Administrator for the Graph permissions. Set `grant_graph_permissions = false` if you do not have that role
  and ask an admin to grant them later.

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

## Not covered

- Key Vault access for the secret-expiry tool: give `web_app_principal_id` "Key Vault Certificates Officer"
  (RBAC vaults) or a list/get certificates access policy on each vault.
- Subscription creation and decommission need billing rights; give those to a separate identity and set it as
  that tool's SPN override in Settings.
- A web app you already built by hand is not adopted; either `terraform import` it or let Terraform create a
  new one with another `name`.
