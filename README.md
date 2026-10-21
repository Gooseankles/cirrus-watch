# Azure ops dashboard

A self-hosted dashboard for the everyday checks and chores of running an Azure tenant: nightly scans for waste,
risky access and broken policy, cost history per subscription, a "who has access to what" lookup, and ServiceNow
tickets that create or decommission subscriptions.

It is a small Node.js (Express) app with a no-build front end. Run it locally with `npm start`, or as a container on
Azure App Service, where the included Terraform sets up everything, including a managed identity, so no secrets
are needed.

## Tools

| Tool | Runs | What it finds or does |
|---|---|---|
| Orphaned resources | Daily | Unattached disks, unused public IPs, orphaned NICs, empty resource groups |
| Tag compliance | Daily | Resources missing required tags (`CostCenter`, `Owner`, `Environment` by default) |
| Cost anomalies | Daily | Subscriptions whose spend jumped against their own recent baseline |
| Access review | Weekly | Long-standing Owner, Contributor and User Access Administrator grants, direct and through groups |
| Expiring app credentials | Daily | App registration secrets and certificates that expire soon |
| Key Vault | Daily | Vault settings (soft delete, purge protection, open networks, access policies); secrets, keys and certificates that expired, expire soon or have no expiry date; who can read secrets (broad roles, many readers, guests, deleted identities); vaults with no audit log, no owner tag, nothing in them or no use |
| Access packages | Daily | Entra access packages that expire soon, wait too long for approval, go unused, auto-approve with no end date or have a single approver |
| Role assignments | Daily | Assignments whose user, group or app was deleted, and subscriptions near Azure's limit of 4,000 role assignments |
| Policy check | Daily | Whether Azure Policy actually works: probes ask Azure if risky resources would be allowed (nothing is created), and health checks find assignments that cannot work (enforcement off, identity missing roles, remediation never run, expired exemptions and more) |
| Cost history | Daily | Daily cost per subscription plus monthly cost by service and resource group, kept for as long as you like |
| Access lookup | On demand | Every Azure role a person holds, directly or through a group, across all subscriptions |
| Subscription creation | ServiceNow ticket | Turns a subscription request ticket into a real subscription and writes the result back to the ticket |
| Subscription decommission | ServiceNow ticket | Cancels a subscription once a safety checklist on the ticket is complete |

Every scan run is kept, so each tool shows a trend and what was new or resolved since the run before. Admins can
start any scan with **Run now** instead of waiting for the schedule.

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
scans need, secretless SSO, and the storage account for run history. See
[infra/terraform/README.md](infra/terraform/README.md).

### As a Terraform module

Use the module from your own configuration and pin a version tag (every version is tagged `v<version>`; see the
repo's tags for the newest):

```hcl
module "dashboard" {
  source = "github.com/Gooseankles/azure-ops-dashboard//infra/terraform/modules/dashboard?ref=v0.8.0.2"

  name     = "contoso-azure-tools"
  location = "norwayeast"
  image    = "trozity/azure-ops-dashboard:0.8.0.2" # the module tag pins the infrastructure, this pins the app

  shared_spn_access = [
    { scope = "/providers/Microsoft.Management/managementGroups/<tenant-id>" },
  ]
  admin_principal_ids = ["<group object id>"]
}
```

All inputs, the provider setup and what each one does are in [infra/terraform/README.md](infra/terraform/README.md).

## Signing in and roles

- **Admin**: everything, plus Run now, cost history refresh and the Settings page.
- **User**: read-only.

Two ways to sign in, either or both:

### Local admin account

Set `DASHBOARD_ADMIN_PASSWORD`. The username is always `admin` and it always has the Admin role. Handy before SSO
exists or as a break-glass login; leave it blank to turn it off. Use a strong password if the dashboard is
reachable by anyone else.

### SSO with an Entra ID app registration

This is a separate app registration from the identity the scans use: it only signs people in to the dashboard.

1. Entra ID → App registrations → New registration. Add a redirect URI of type **Web**:
   `https://<your host>/auth/callback` (for local use `http://localhost:7070/auth/callback`). It must match
   `DASHBOARD_REDIRECT_URI` exactly.
2. Either create a client secret (`DASHBOARD_AZURE_CLIENT_SECRET`), or, on App Service, go secretless: attach a
   user-assigned managed identity to the web app, add a federated credential for it on the app registration
   (scenario "Managed identity") and set its client ID as `DASHBOARD_FEDERATED_MI_CLIENT_ID`.
3. App roles → create `Admin` and `User` (allowed member types: Users/Groups).
4. Set `DASHBOARD_AZURE_TENANT_ID` and `DASHBOARD_AZURE_CLIENT_ID`.
5. Enterprise applications → this app → Properties → **Assignment required** = Yes, so only people you add can
   sign in.
6. Users and groups → assign people or groups to Admin or User. Roles live only in Entra; the dashboard reads the
   `roles` claim on the ID token.

## Permissions

The scans only read. Give the scan identity (by default the web app's managed identity, or a service principal):

- **Reader** on every subscription to scan. Assign it at a management group and new subscriptions are picked up
  automatically. Policy check needs nothing more.
- **Cost Management Reader** for cost anomalies and cost history.
- **Microsoft Graph application permissions**, with admin consent: `User.Read.All`, `GroupMember.Read.All`,
  `Application.Read.All` and `EntitlementManagement.Read.All` (the last only matters with Entra ID Governance /
  P2 access packages).
- **Key Vault**: `Key Vault Reader` (lists item names and expiry dates, never secret values) on RBAC vaults, or an
  access policy with list on secrets, keys and certificates. The vault's firewall must let the dashboard in.
  Vault settings, access and logging checks need only Reader.
- **History storage**: `Storage Blob Data Contributor` on the storage account, when `STORAGE_ACCOUNT_URL` is set.

Subscription creation and decommission need rights on a billing scope (e.g. the **Azure subscription creator**
role on an EA enrollment account or an MCA invoice section). Give those to a separate identity: every tool can
have its own identity (Settings → SPN override, or `<TOOL_ID>_AZURE_CLIENT_ID` and friends in `.env`), and a tool
without one uses the shared identity. Missing permissions show up as an error entry on the tool's page and in the
activity log, never as an empty result.

## ServiceNow integration

1. A ticket (e.g. a catalog request) asks for a new subscription.
2. A Business Rule or Flow Designer action calls `POST /webhook/create-subscription` with the header
   `X-Webhook-Secret: <WEBHOOK_SHARED_SECRET>` and this body:
   ```json
   {
     "ticketNumber": "${number}",
     "table": "${table_name}",
     "sysId": "${sys_id}",
     "displayName": "${short_description}"
   }
   ```
3. The dashboard creates the subscription with the `Microsoft.Subscription/aliases` API under
   `AZURE_BILLING_SCOPE` (optionally placed in `AZURE_MANAGEMENT_GROUP_ID`) and writes a work note back to the
   ticket. Use a dedicated ServiceNow API user (`SNOW_API_USER` / `SNOW_API_PASSWORD`) with access to that table.

Decommissioning works the same way through `POST /webhook/decommission-subscription`, and is refused unless the
ticket's checklist confirms every item:

```json
{
  "ticketNumber": "REQ0010099",
  "table": "sc_request",
  "sysId": "abc123",
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "checklist": { "backupsConfirmed": true, "dnsRemoved": true, "budgetAlertsCleared": true }
}
```

To try it without a company instance, the free ServiceNow Developer Program (https://developer.servicenow.com)
gives you a personal developer instance.

## Where data is kept

- **Scan results and run history, cost history**: in an Azure Storage blob container when `STORAGE_ACCOUNT_URL` is
  set (reached with an Entra token; account keys can stay off), otherwise under `DATA_DIR` (default `./data`).
  Runs are kept for `HISTORY_RETENTION_DAYS` (default 365).
- **Settings page overrides and sign-in sessions**: under `DATA_DIR`.
- **Activity log**: JSON lines in `runs.jsonl`, under `DATA_DIR/logs` when `DATA_DIR` is set, otherwise `./logs`.

`.env`, `data/` and `logs/` are ignored by git; never commit real secrets.

## Adding a tool

A scan tool is a file in `src/tools/` exporting `{ id, label, schedule, run() }`, where `run()` returns a list of
findings; register it with `registerScanTool` in `server.js` and add it to the `TOOLS` list in `public/app.js`.
An on-demand tool exports `{ id, label, registerRoutes(app) }` and uses `registerActionTool`.
