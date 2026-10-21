# Azure ops dashboard

A self-hosted dashboard for the everyday checks and chores of running an Azure tenant: nightly scans for waste,
risky access and broken policy, cost history per subscription and a "who has access to what" lookup.

It is a small Node.js (Express) app with a no-build front end. Run it locally with `npm start`, or as a container on
Azure App Service, where the included Terraform sets up everything, including a managed identity, so no secrets
are needed.

## Tools

| Tool | Runs | What it finds or does |
|---|---|---|
| Orphaned resources | Daily | Unattached disks, unused public IPs, orphaned NICs, empty resource groups |
| Tag compliance | Daily | Resources missing required tags (`CostCenter`, `Owner`, `Environment` by default) |
| Cost anomalies | Daily | Subscriptions whose spend jumped against their own recent baseline |
| Access review | Weekly | Long-standing Owner, Contributor and User Access Administrator grants, direct and through groups (nested groups shown as a tree) |
| Expiring app credentials | Daily | App registration secrets and certificates that expire soon |
| Key Vault | Daily | Vault settings (soft delete, purge protection, open networks, access policies); secrets, keys and certificates that expired, expire soon or have no expiry date; who can read secrets (broad roles, many readers, guests, deleted identities); vaults with no audit log, no owner tag, nothing in them or no use |
| Access packages | Daily | Entra access packages that expire soon, wait too long for approval, go unused, auto-approve with no end date or have a single approver |
| Role assignments | Daily | Assignments whose user, group or app was deleted, and subscriptions near Azure's limit of 4,000 role assignments |
| Policy check | Daily | Whether Azure Policy actually works: probes ask Azure if risky resources would be allowed (nothing is created), and health checks find assignments that cannot work (enforcement off, identity missing roles, remediation never run, expired exemptions and more) |
| Internet exposure | Daily | NSG rules open to the whole internet (admin, database or all ports), VMs with a public IP, storage containers anyone can read, database firewalls open to everyone or to all of Azure |
| End of support | Weekly | AKS Kubernetes versions out of support, App Service runtimes and VM operating systems past or near end of support, services that still accept TLS 1.0/1.1 |
| Service retirements | Daily | Azure features being retired that your resources still use (from Azure Advisor), with the date |
| Backup coverage | Daily | VMs with no backup, backups stopped, failing or too old, vaults without soft delete or with locally redundant storage |
| Diagnostic settings | Daily | Resources whose logs go nowhere, subscriptions whose activity log is not exported |
| Quotas | Daily | Compute, network and storage quotas close to their limit in the regions you use |
| Change log | Daily | What people and apps created, changed or deleted in the last 24 hours, security changes marked (for information; not in totals or the report) |
| Cost history | Daily | Daily cost per subscription plus monthly cost by service and resource group, kept for as long as you like |
| Access lookup | On demand | Every Azure role a person holds, directly or through a group, across all subscriptions |

Every scan run is kept, so each tool shows a trend and what was new or resolved since the run before. Admins can
start any scan with **Run now** instead of waiting for the schedule.

### Accepting findings, monthly report, compliance tags

- **Accept or snooze**: a finding that is known and fine (the public IP is the VPN gateway) can be accepted with a
  reason, for 30 to 365 days, until a chosen date or until reopened. It stays in the results but no longer counts as
  open; a snoozed one counts again from its end date. The **Accepted** chip on a scan page lists them, with who
  accepted them and why, and reopens them. Needs Run now rights in the finding's tenant (`Admin` or
  `Admin-<key>`); every accept and reopen goes to the activity log. Stored per tenant as
  `suppressions/<tool>.json` next to the scan results. API: `POST /api/tools/<id>/accept`
  `{ key, tenant, reason, until }` (`until` = `YYYY-MM-DD` or null) and `POST /api/tools/<id>/unaccept` `{ key, tenant }`.
- **Monthly report** (`#/report`): for one tenant or all you can see, where every scan stood at the end of the
  month against its start, a score out of 100, open critical findings, what was found and fixed, and the
  compliance controls with open findings. **Print / PDF** gives a light, printable page for the customer.
  API: `GET /api/report?month=YYYY-MM[&tenant=<key>]`.
- **Compliance tags**: each finding shows the CIS Controls v8 safeguards and NIS2 Article 21(2) points it bears on
  (`public/compliance.js`), and the scan pages filter on them. A finding shows a control is not met somewhere; no
  finding does not prove it is met.

## Quick start

### Docker

```
docker run -p 7070:7070 -e DASHBOARD_ADMIN_PASSWORD=<choose one> -e SESSION_SECRET=<long random string> \
  -e DATA_DIR=/app/data -v azure-ops-data:/app/data trozity/azure-ops-dashboard:latest
```

Open http://localhost:7070 and sign in as `admin`. Image tags: `latest` (every push to `main`), `stable` (promoted
by hand with the "Promote to stable" workflow once a build has proven itself), each version (e.g. `0.7.0.0`) and
`sha-<commit>`.

### From source

```
npm install
cp .env.example .env    # then fill it in
npm start
```

Uses Node.js 20 (the version the image is built on). Set the Azure connection in `.env` or later on the dashboard's Settings page.

### On Azure App Service

`infra/terraform` creates the App Service, the managed identity with the read roles and Graph permissions the
scans need, secretless SSO, the storage account for run history and the key vault for secrets entered in Settings. See
[infra/terraform/README.md](infra/terraform/README.md).

### As a Terraform module

Use the module from your own configuration and pin a version tag (every version is tagged `v<version>`; see the
repo's tags for the newest):

```hcl
module "dashboard" {
  source = "github.com/Gooseankles/azure-ops-dashboard//infra/terraform/modules/dashboard?ref=v0.14.0.0"

  name     = "contoso-azure-tools"
  location = "norwayeast"
  image    = "trozity/azure-ops-dashboard:0.14.0.0" # the module tag pins the infrastructure, this pins the app

  shared_spn_access = [
    { scope = "/providers/Microsoft.Management/managementGroups/<tenant-id>" },
  ]
  admin_principal_ids = ["<group object id>"]
}
```

All inputs, the provider setup and what each one does are in [infra/terraform/README.md](infra/terraform/README.md).
To let only some public IPs reach the site, set `allowed_ip_ranges` (see "Access restrictions" there).

## Signing in and roles

- **Admin**: everything, every tenant, plus Run now, cost history refresh and the Settings page.
- **User**: read-only, every tenant.
- **Admin-&lt;key&gt;**: one customer tenant (see "Customer tenants" below): read it and run its scans.
- **User-&lt;key&gt;**: one customer tenant, read-only.

A person can hold several roles, for example `User-acme` and `Admin-globex`, and then sees only those tenants.
Role values are matched without regard to case. An SSO account with no role is refused, even when the Enterprise
App does not require assignment. With Terraform, each role gets an Entra security group (`create_role_groups`), so
access is given by adding people to groups.

Two ways to sign in, either or both:

### Local admin account

Set `DASHBOARD_ADMIN_PASSWORD`. The username is always `admin` and it always has the Admin role. Handy before SSO
exists or as a break-glass login; leave it blank to turn it off. Use a strong password if the dashboard is
reachable by anyone else. After 10 wrong passwords from one address, that address must wait 15 minutes.

### SSO with an Entra ID app registration

This is a separate app registration from the identity the scans use: it only signs people in to the dashboard.

1. Entra ID → App registrations → New registration. Add a redirect URI of type **Web**:
   `https://<your host>/auth/callback` (for local use `http://localhost:7070/auth/callback`). It must match
   `DASHBOARD_REDIRECT_URI` exactly.
2. Either create a client secret (`DASHBOARD_AZURE_CLIENT_SECRET`), or, on App Service, go secretless: attach a
   user-assigned managed identity to the web app, add a federated credential for it on the app registration
   (scenario "Managed identity") and set its client ID as `DASHBOARD_FEDERATED_MI_CLIENT_ID`.
3. App roles → create `Admin` and `User`, plus `Admin-<key>` and `User-<key>` per customer tenant (allowed member
   types: Users/Groups).
4. Set `DASHBOARD_AZURE_TENANT_ID` and `DASHBOARD_AZURE_CLIENT_ID`.
5. Enterprise applications → this app → Properties → **Assignment required** = Yes, so only people you add can
   sign in.
6. Users and groups → assign people or groups to Admin or User. Roles live only in Entra; the dashboard reads the
   `roles` claim on the ID token.

## Customer tenants

One dashboard can scan other organizations' tenants as well as its own, so it is hosted in one place. Each tenant
gets a tab at the top of the page ("All tenants" shows them together, with the tenant next to each row), its own
storage container, and its own roles (above). Its scans run in that tenant as that tenant's app registration; the
home tenant keeps using the shared SPN.

Each customer tenant has its own app registration, made there by hand, with a client secret. Give that app the
Graph application permissions (with admin consent) and Reader, Cost Management Reader and Key Vault Reader on the
subscriptions (step by step in [docs/permissions.md](docs/permissions.md#customer-tenant-app-other-tenants)), put
its client ID in Terraform's `customers` (`client_id`) or in Settings, and paste its secret in Settings → Customer
tenants → Edit (only there, so it never lands in the Terraform state; it is kept in the key vault, and the page
shows whether one is set, never the value). `terraform output customer_onboarding` prints every step per customer; Terraform never
touches a customer tenant. A secretless sign-in is not possible here: Entra does not let an app trust a managed
identity of another tenant.

Customers come from Terraform (`customers`, passed to the app as `DASHBOARD_TENANTS`); Settings → Customer tenants
lists them, tests each one and can change the client ID, name or subscriptions or turn scanning off. On a
customer's tab, Settings shows that customer's own tool settings (required tags, warning days, policy probes,
cost thresholds and the like); blank = the Home value. Sign-in, storage and the per-tool SPNs are set on the Home
tab only. A tenant added
only in Settings works, but has no Admin-&lt;key&gt; / User-&lt;key&gt; roles, so only global Admin and User see it. A customer tenant delegated to your tenant with Azure Lighthouse
can instead be scanned by the home identity like any other subscription; then it does not need to be added here.

## Permissions

Every identity and what it needs (home tenant, customer tenants, the app's own storage and vault, and whoever runs
Terraform) is in **[docs/permissions.md](docs/permissions.md)**. In short, the scans only read. Give the scan
identity (by default the web app's managed identity, or a service principal):

- **Reader** on every subscription to scan. Assign it at a management group and new subscriptions are picked up
  automatically. Policy check, internet exposure, end of support, service retirements, backup coverage,
  diagnostic settings, quotas and the change log need nothing more.
- **Cost Management Reader** for cost anomalies and cost history.
- **Microsoft Graph application permissions**, with admin consent: `User.Read.All`, `GroupMember.Read.All`,
  `Application.Read.All` and `EntitlementManagement.Read.All` (the last only matters with Entra ID Governance /
  P2 access packages).
- **Key Vault**: `Key Vault Reader` (lists item names and expiry dates, never secret values) on RBAC vaults, or an
  access policy with list on secrets, keys and certificates. The vault's firewall must let the dashboard in.
  Vault settings, access and logging checks need only Reader.
- **History storage**: `Storage Blob Data Contributor` on the storage account, when `STORAGE_ACCOUNT_URL` is set.
- **Secret vault**: `Key Vault Secrets Officer` on the dashboard's own key vault, when `SECRET_VAULT_URL` is set.

Every tool can have its own identity (Settings → SPN override, or `<TOOL_ID>_AZURE_CLIENT_ID` and friends in
`.env`), and a tool without one uses the shared identity. Missing permissions show up as an error entry on the
tool's page and in the activity log, never as an empty result.

## Where data is kept

- **Scan results and run history, cost history**: in an Azure Storage blob container when `STORAGE_ACCOUNT_URL` is
  set (reached with an Entra token; account keys can stay off), otherwise under `DATA_DIR` (default `./data`).
  Each customer tenant has its own container, `dashboard-<key>` (on disk `DATA_DIR/tenants/<key>`), so one
  customer's data never sits next to another's. Runs are kept for `HISTORY_RETENTION_DAYS` (default 365).
  With Terraform's `private_network = true` the storage account is reached only through a private endpoint and
  its public network access is off.
- **Client secrets entered in Settings** (SPN overrides, customer tenants): in an Azure key vault when
  `SECRET_VAULT_URL` is set (Terraform creates one; the app reads and writes it with its managed identity, as
  secrets named `dashboard-…`), otherwise in `settings.json` / `tenants.json` under `DATA_DIR`. Secrets already in
  those files move to the vault at start-up, and are removed from the file once the vault has them. If the vault
  cannot be reached, the dashboard still starts, says so on the tools that need a secret, refuses to save new
  secrets and retries every minute. `GET /api/secret-store` (Admin) shows which store is in use.
- **Accepted and snoozed findings**: with each tenant's scan results (`suppressions/<tool>.json`).
- **Other Settings page overrides and sign-in sessions**: under `DATA_DIR`.
- **Activity log**: JSON lines in `runs.jsonl`, under `DATA_DIR/logs` when `DATA_DIR` is set, otherwise `./logs`.

`.env`, `data/` and `logs/` are ignored by git; never commit real secrets.

## Adding a tool

A scan tool is a file in `src/tools/` exporting `{ id, label, schedule, run() }`, where `run()` returns a list of
findings; register it with `registerScanTool` in `server.js` and add it to the `TOOLS` list in `public/app.js`
(each new finding kind gets a `KINDS` entry there and its controls in `public/compliance.js`).
An on-demand tool exports `{ id, label, registerRoutes(app) }` and uses `registerActionTool`.
