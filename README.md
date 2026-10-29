# Cirrus Watch

A self-hosted dashboard for the everyday checks and chores of running an Azure tenant: nightly scans for waste,
risky access and broken policy, cost history per subscription and a "who has access to what" lookup.

It is a small Node.js (Express) app with a no-build front end. Run it locally with `npm start`, or as a container on
Azure App Service, where the [Terraform module](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard) sets up everything, including a managed identity, so no secrets
are needed.

## Tools

Each tool in a line; [docs/tools.md](docs/tools.md) has what each one checks in full.

<!-- tools:start -->
| Tool | Runs | What it finds or does |
| --- | --- | --- |
| [Orphaned resources](docs/tools.md#orphaned-resources) | Daily | Leftovers that cost money or clutter the tenant, priced at list price, and what cleaning up has saved. |
| [Tag compliance](docs/tools.md#tag-compliance) | Daily | Resources missing the tags you require. |
| [Cost anomalies](docs/tools.md#cost-anomalies) | Daily | Resource groups whose cost yesterday jumped against the day before. |
| [Access review](docs/tools.md#access-review) | Weekly | Long-standing Owner, Contributor and User Access Administrator grants, direct and through groups. |
| [Expiring app credentials](docs/tools.md#expiring-app-credentials) | Daily | App secrets and certificates that expire soon, and app registrations with risky credentials or no owner. |
| [Key Vault](docs/tools.md#key-vault) | Daily | Vault settings, expiring vault items (optional) and who can read secrets. |
| [Access packages](docs/tools.md#access-packages) | Daily | Entra access packages that expire, wait for approval, go unused or cannot be approved. |
| [Role assignments](docs/tools.md#role-assignments) | Daily | Assignments to deleted identities and subscriptions near the role assignment limit. |
| [Policy check](docs/tools.md#policy-check) | Daily | Whether Azure Policy actually blocks risky resources, and assignments that cannot work. |
| [Internet exposure](docs/tools.md#internet-exposure) | Daily | NSG rules, VMs, storage and databases open to the internet. |
| [End of support](docs/tools.md#end-of-support) | Weekly | Kubernetes versions, runtimes, operating systems and TLS versions past or near end of support. |
| [Service retirements](docs/tools.md#service-retirements) | Daily | Azure features being retired that your resources still use, with the date. |
| [Certificates](docs/tools.md#certificates) | Daily | TLS certificates of App Service custom domains and listed websites: expiry, name, trust and reachability. |
| [Backup coverage](docs/tools.md#backup-coverage) | Daily | VMs with no backup, failing or old backups, and weak vault settings. |
| [Resilience](docs/tools.md#resilience) | Daily | What one failure would take down: resources not spread over zones or instances. |
| [Resource settings](docs/tools.md#resource-settings) | Daily | Risky settings on storage, SQL, web apps, registries, AKS, Redis and other services. |
| [Exposure paths](docs/tools.md#exposure-paths) | Daily | Attack paths across resources, from internet-facing machines to what their identity and network can reach. |
| [Diagnostic settings](docs/tools.md#diagnostic-settings) | Daily | Resources and subscriptions whose logs go nowhere, and missing flow logs. |
| [Quotas](docs/tools.md#quotas) | Daily | Compute, network and storage quotas close to their limit. |
| [IP addresses](docs/tools.md#ip-addresses) | Daily | Address space use, overlaps and free ranges (the IPAM page), and firewall IP groups. |
| [Architecture](docs/tools.md#architecture) | Daily | A drawing of VNets, subnets and resources, with the traffic each VM can send (for information). |
| [Firewall policies](docs/tools.md#firewall-policies) | Daily | Every firewall rule in the order it is checked, the rules that are wrong or redundant, and a reach map per VM or IP. |
| [Change log](docs/tools.md#change-log) | Daily | What was created, changed or deleted in the last 24 hours (for information). |
| [Privileged roles](docs/tools.md#privileged-roles) | Daily | Who holds the powerful Entra roles and whether they are protected. |
| [PIM](docs/tools.md#pim) | Daily | Everyone who can activate a role, and PIM settings and assignments that are too loose. |
| [Stale accounts](docs/tools.md#stale-accounts) | Daily | Members and guests who have not signed in for a long time, or never. |
| [MFA coverage](docs/tools.md#mfa-coverage) | Daily | Enabled members with no MFA method, or only phone and SMS. |
| [Conditional Access](docs/tools.md#conditional-access) | Daily | Gaps in Conditional Access policies. |
| [App permissions](docs/tools.md#app-permissions) | Daily | Apps with Graph permissions that could take over the tenant, and risky consents. |
| [Licence coverage](docs/tools.md#licence-coverage) | Daily | Entra ID licences needed for the features in use, against those you own. |
| [Defender for Cloud](docs/tools.md#defender-for-cloud) | Daily | Low secure scores, unhealthy recommendations and Defender plans that are off. |
| [Safety nets](docs/tools.md#safety-nets) | Daily | Subscriptions with no working budget and key resources with no delete lock. |
| [Azure Monitor](docs/tools.md#azure-monitor) | Daily | Machines, alert rules, action groups and workspaces that Azure Monitor does not cover or that do not work. |
| [Updates and patching](docs/tools.md#updates-and-patching) | Daily | Machines with pending Critical or Security updates, missing assessments or failed installations. |
| [Entra tenant settings](docs/tools.md#entra-tenant-settings) | Daily | Tenant settings that let any user register apps, invite guests or create tenants. |
| [Resource health](docs/tools.md#resource-health) | Hourly | Resources that are down or degraded now, Azure outages and planned maintenance. |
| [Subscriptions](docs/tools.md#subscriptions) | Daily | Subscriptions in the Tenant Root Group, with no Owner, or not in good standing. |
| [Network hygiene](docs/tools.md#network-hygiene) | Daily | WAFs that block nothing, dangling DNS records and routes to nowhere. |
| [Cost history](docs/tools.md#cost-history) | Daily | Daily cost per subscription and monthly cost by service and resource group. |
| [Access lookup](docs/tools.md#access-lookup) | On demand | Every Azure and Entra role a person or group holds or can activate, with the group chain. |
<!-- tools:end -->

Every scan run is kept, so each tool shows a trend and what was new or resolved since the run before. Admins can
start any scan with **Run now** instead of waiting for the schedule.

Scans a tenant does not need can be turned off in Settings → Scans, on that tenant's tab: they no longer run there,
their results are hidden (also in the report, trends and compliance), and a scan off in every tenant you look at
leaves the menu. A customer tenant's list does not follow Home: there, all scans are on until you untick some.

### Accepting findings, monthly report, compliance tags

- **Accept or snooze**: a finding that is known and fine (the public IP is the VPN gateway) can be accepted with a
  reason, for 30 to 365 days, until a chosen date or until reopened. It stays in the results but no longer counts as
  open; a snoozed one counts again from its end date. The **Accepted** chip on a scan page lists them, with who
  accepted them and why, and reopens them. Anyone who may read the scan in the finding's tenant may accept or
  reopen it; every accept and reopen goes to the activity log. Stored per tenant as
  `suppressions/<tool>.json` next to the scan results. API: `POST /api/tools/<id>/accept`
  `{ key, tenant, reason, until }` (`until` = `YYYY-MM-DD` or null) and `POST /api/tools/<id>/unaccept` `{ key, tenant }`.
- **Monthly report** (`#/report`): for one tenant or all you can see, where every scan stood at the end of the
  month against its start, a score out of 100, open critical findings, what was found and fixed, and the
  compliance controls with open findings. **Print / PDF** gives a light, printable page for the customer.
  API: `GET /api/report?month=YYYY-MM[&tenant=<key>]`.
- **Weekly trends** (`#/trends`): open findings at the end of each week across every scan (by severity and per
  tool), with what was found and fixed each week, for 8 to 52 weeks. Built from the stored run history, so it runs
  no scans; a tool's first scan counts as the starting point, not as new findings. API:
  `GET /api/trends?weeks=12[&tenant=<key>]`.
- **Compliance tags**: each finding shows the NIS2 Article 21(2) points, the sections of the NIS2 Implementing
  Regulation (EU) 2024/2690, NSM ICT security principles (Norway's baseline, v2.1) and CIS Controls v8.1 safeguards it
  bears on (`public/compliance.js`), and the scan pages filter on
  them. A finding shows a control is not met somewhere; no finding does not prove it is met.
- **Compliance page** (`#/compliance`): every NIS2 point, Implementing Regulation section, NSM principle or mapped CIS
  safeguard for the tenant tab in
  view: critical findings, findings, no findings (the scans that look at it ran and found nothing), not run yet, or
  check by hand (training, incident handling, supplier contracts: things no scan can see). Each row links the scans
  that check it and when they last ran. **Print / PDF** as for the report. Built from the scans only; Microsoft
  Defender for Cloud is not needed.

## Quick start

### Docker

```sh
docker run -p 7070:7070 -e DASHBOARD_ADMIN_PASSWORD=<choose one> -e SESSION_SECRET=<long random string> \
  -e DATA_DIR=/app/data -v azure-ops-data:/app/data trozity/azure-ops-dashboard:latest
```

Open <http://localhost:7070> and sign in as `admin`. Image tags: `latest` (every push to `main`), `stable` (promoted
by hand with the "Promote to stable" workflow once a build has proven itself), and each version (e.g.
`0.7.0.0`).

### From source

```sh
npm install
cp .env.example .env    # then fill it in
npm start
```

Uses Node.js 26 (the version the image is built on; the Azure libraries need 22 or newer). Set the Azure connection in `.env` or later on the dashboard's Settings page.

### On Azure App Service

The Terraform module in its own public repo, [terraform-azurerm-ops-dashboard](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard), creates the App
Service, the managed identity with the read roles and Graph permissions the scans need, secretless SSO, the storage
account for run history and the key vault for secrets entered in Settings. Its `examples/default` folder is a
ready-made root configuration.

### As a Terraform module

Use the module from your own configuration and pin a version tag (`v<major>.<minor>.<patch>`; see that repo's tags
for the newest):

```hcl
module "dashboard" {
  source = "github.com/Gooseankles/terraform-azurerm-ops-dashboard?ref=v1.5.1"

  name     = "contoso-azure-tools"
  location = "norwayeast"
  image    = "trozity/azure-ops-dashboard:stable" # or a version such as 0.57.1.0; the module tag pins the infrastructure, this pins the app

  shared_spn_access = [
    { scope = "/providers/Microsoft.Management/managementGroups/<tenant-id>" },
  ]
  admin_principal_ids = ["<group object id>"]
}
```

All inputs, the provider setup and what each one does are in the [module's README](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard#readme).
To let only some public IPs reach the site, set `allowed_ip_ranges` (see "Access restrictions" there).

## Signing in and roles

- **Admin**: every tenant, plus the Settings page.
- **User**: every tenant.
- **Admin-&lt;key&gt;** / **User-&lt;key&gt;**: one customer tenant (see "Customer tenants" below).
- **&lt;Area&gt;.Read**: one area in every tenant.
- **&lt;Area&gt;.Read-&lt;key&gt;**: one area in one tenant.

Whoever may see a scan may also run it (Run now, cost history refresh). The `<Area>.Run` roles of older versions
still work and count as `<Area>.Read`.

Areas let each team see only its own scans. Area is `Identity`, `Platform`, `Security` or `Cost`; a scan can sit in
more than one (`TOOL_AREAS` in `src/access.js`):

| Area | Scans |
| --- | --- |
| Identity | Access lookup, access review, secret expiry, access packages, role assignments, PIM, stale accounts, tenant settings, licence coverage, privileged roles, app permissions, Conditional Access, MFA coverage |
| Security | Privileged roles, app permissions, Conditional Access, MFA coverage, Defender for Cloud, internet exposure, exposure paths, firewall policies, network hygiene, Key Vault, resource settings, diagnostic settings, change log |
| Platform | Defender for Cloud, internet exposure, exposure paths, firewall policies, network hygiene, Key Vault, resource settings, diagnostic settings, change log, IPAM, tags, end of support, service retirements, certificates, backup coverage, resilience, updates, resource health, architecture, policy check, safety nets, Azure Monitor, subscriptions, quotas, orphaned resources, cost anomalies, cost history |
| Cost | Orphaned resources, cost anomalies, cost history |

Whoever may see a scan may also run it and accept or snooze its findings. Settings stays with `Admin`; the server
log lines and notifications are shown to `Admin` and `User`.

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
3. App roles → create `Admin` and `User`, plus `Admin-<key>` and `User-<key>` per customer tenant and the area
   roles you want (`Security.Read`, `Platform.Read-acme` and so on) (allowed member types: Users/Groups).
4. Set `DASHBOARD_AZURE_TENANT_ID` and `DASHBOARD_AZURE_CLIENT_ID`.
5. Enterprise applications → this app → Properties → **Assignment required** = Yes, so only people you add can
   sign in.
6. Users and groups → assign people or groups to Admin or User. Roles live only in Entra; the dashboard reads the
   `roles` claim on the ID token.

The sidebar groups (Access, Identity, Resources and so on) fold away with a click on their heading; the browser
remembers which are folded.

### Audit log

Admin → **Audit log** shows who signed in (and refused or failed sign-ins), which pages they opened (each scan,
the monthly report, cost history, a past run, a subscription's cost), whom they looked up in Access lookup, and
what they changed: Run now, accepted, snoozed and reopened findings, settings (which ones, never the values),
customer tenants and Test buttons. A refused request (403) is kept too. Opening the same page again within ten
minutes counts once. Kept `AUDIT_RETENTION_DAYS` (default 365); only Admin can read it.

### Server load

Admin → **Server load** watches the dashboard's own App Service: CPU and memory of the instance, the dashboard's
own memory and heap, and how quickly it answers (event-loop delay), sampled every 15 seconds and kept 48 hours as
the worst value of each minute. Each point and each scan run records which scans were running, so the page shows
which scan pushed the load up, with a timeline, the peak of every run and a list of restarts (marked when the
previous one did not stop cleanly, for example out of memory). An alarm goes to Recent activity, with the
scans running at the time, when CPU stays above `MONITOR_CPU_WARN_PCT` (90) for 5 minutes, memory or heap passes
`MONITOR_MEMORY_WARN_PCT` (85), or answers take longer than `MONITOR_LAG_WARN_MS` (2000); another line follows when
it is back to normal. For email, set `alert_emails` in Terraform (see the module's README, Load alarms).

### Notifications

Each tenant can have one notification link (Settings → Notifications, on that tenant's tab; Admin only). Once a
day at `NOTIFY_TIME` (server time, default 08:30, after the nightly scans) the tenant gets one message with what
turned up since the last one: new findings, grouped by tool (up to 25 listed, the rest counted), and scans that
failed. Accepted and snoozed findings and the change log are left out, a tool's first run in a tenant does not count
everything as new, and a day with nothing new sends nothing. A tenant only gets its own findings.

The link can be:

- **Teams**: in the channel, Workflows → "Post to a channel when a webhook request is received", and copy the link.
  The message is an Adaptive Card with a button to the dashboard (taken from `DASHBOARD_REDIRECT_URI`).
- **Slack**: an incoming webhook (`hooks.slack.com`); it gets plain text.
- **Any other https endpoint** (Power Automate, Logic Apps, n8n): it gets the Teams body plus `text` and a
  `summary` object with the tenant, counts and items.
- **Email addresses** (comma-separated, up to 20), for when the organization blocks webhooks. A Teams channel's
  email address (channel ⋯ → Get email address) works too, if the organization allows mail to channels. The mail
  goes out through Microsoft Graph from the mailbox in **Send email from** (Settings → Notifications on the Home
  tab, `NOTIFY_MAIL_FROM`): a mailbox in the home tenant (a shared mailbox is fine), whichever tenant the message is
  about. The dashboard's identity (app or managed identity) needs the right to send as that mailbox, best given in
  Exchange Online with **RBAC for Applications**, limited to that mailbox, and *not* as Graph `Mail.Send` in Entra
  (an Entra grant works for every mailbox and overrides the Exchange limit):

  ```powershell
  Connect-ExchangeOnline
  New-DistributionGroup -Name "Dashboard Mailer Scope" -Type Security -Members alerts@contoso.com
  New-ServicePrincipal -AppId <app id> -ObjectId <enterprise app object id> -DisplayName "Cirrus Watch mailer"
  $dn = (Get-DistributionGroup "Dashboard Mailer Scope").DistinguishedName
  New-ManagementScope -Name "Dashboard Mailer Mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '$dn'"
  New-ManagementRoleAssignment -App <app id> -Role "Application Mail.Send" -CustomResourceScope "Dashboard Mailer Mailboxes"
  Test-ServicePrincipalAuthorization -Identity <app id> -Resource alerts@contoso.com   # InScope = True
  ```

  The role can take up to two hours to apply.

The link carries its own signature, so it is kept like a client secret (the key vault when `SECRET_VAULT_URL` is
set, else `notify.json` under `DATA_DIR`) and never shown again. What is waiting is kept in `notify-queue.json`. A
failed send is logged in Recent activity and tried again every hour. Send test posts a test message at once.

## Customer tenants

One dashboard can scan other organizations' tenants as well as its own, so it is hosted in one place. Each tenant
gets a tab at the top of the page ("All tenants" shows them together, with the tenant next to each row), its own
storage container, and its own roles (above). Its scans run in that tenant as that tenant's app registration; the
home tenant keeps using the shared SPN.

Each customer tenant has its own app registration, made there by hand, with a client secret. Give that app the
Graph application permissions (with admin consent) and Reader and Cost Management Reader on the
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

## Architecture

How the pieces fit together (Azure resources, identities, sign-in, a scan run, customer tenants, network, build and
release, the code inside, where data is kept), with diagrams: **[docs/architecture.md](docs/architecture.md)**.

## Permissions

Every identity and what it needs (home tenant, customer tenants, the app's own storage and vault, and whoever runs
Terraform) is in **[docs/permissions.md](docs/permissions.md)**. In short, the scans only read. Give the scan
identity (by default the web app's managed identity, or a service principal):

- **Reader** on every subscription to scan. Assign it at a management group and new subscriptions are picked up
  automatically. Policy check, internet exposure, end of support, service retirements, certificates, Defender for Cloud, safety nets, backup coverage,
  diagnostic settings, quotas, IP addresses, firewall policies, architecture and the change log need nothing more.
- **Cost Management Reader** for cost anomalies and cost history.
- **Microsoft Graph application permissions**, with admin consent: `User.Read.All`, `GroupMember.Read.All`,
  `Application.Read.All`, `EntitlementManagement.Read.All` (only matters with Entra ID Governance / P2 access
  packages), `RoleManagement.Read.Directory` (privileged roles, Entra roles in access lookup), `AuditLog.Read.All` (stale accounts, MFA coverage, admin MFA;
  needs Entra ID P1), `Policy.Read.All` (Conditional Access, consent settings) and
  `DelegatedPermissionGrant.Read.All` (app consents), `LicenseAssignment.Read.All` (licences owned) and
  `PrivilegedEligibilitySchedule.Read.AzureADGroup` + `PrivilegedAssignmentSchedule.Read.AzureADGroup` (PIM for
  Groups, for licence coverage). All read-only. Email notifications need a send right in the home tenant, given in
  Exchange (see Notifications), not here.
- **Key Vault**: vault settings, access and logging checks need only Reader. The optional item check
  (`KEYVAULT_ITEM_CHECK`, off by default) also needs `Key Vault Reader` (lists item names and expiry dates, never
  secret values) on RBAC vaults, or an access policy with list on secrets, keys and certificates, and the vault's
  firewall must let the dashboard in.
- **History storage**: `Storage Blob Data Contributor` on the storage account, when `STORAGE_ACCOUNT_URL` is set.
- **Secret vault**: `Key Vault Secrets Officer` on the dashboard's own key vault, when `SECRET_VAULT_URL` is set.

Every tool can have its own identity (Settings → SPN override, or `<TOOL_ID>_AZURE_CLIENT_ID` and friends in
`.env`), and a tool without one uses the shared identity. Missing permissions show up as an error entry on the
tool's page and in the activity log, never as an empty result. A failed scan lists the permissions, roles and
licence that tool needs, and the Test buttons in Settings (shared SPN, SPN overrides, customer tenants) check them:
which Graph application permissions the identity was granted (from its token) and which Azure roles it holds on
each subscription it can see.

## Where data is kept

- **Scan results and run history, cost history**: in an Azure Storage blob container when `STORAGE_ACCOUNT_URL` is
  set (reached with an Entra token; account keys can stay off), otherwise under `DATA_DIR` (default `./data`).
  Each customer tenant has its own container, `dashboard-<key>` (on disk `DATA_DIR/tenants/<key>`), so one
  customer's data never sits next to another's. Runs are kept for `HISTORY_RETENTION_DAYS` (default 365; the Terraform module sets 730).
  With Terraform's `private_network = true` the storage account is reached only through a private endpoint and
  its public network access is off.
- **Client secrets and notification links entered in Settings** (SPN overrides, customer tenants, notifications): in an Azure key vault when
  `SECRET_VAULT_URL` is set (Terraform creates one; the app reads and writes it with its managed identity, as
  secrets named `dashboard-…`), otherwise in `settings.json` / `tenants.json` under `DATA_DIR`. Secrets already in
  those files move to the vault at start-up, and are removed from the file once the vault has them. If the vault
  cannot be reached, the dashboard still starts, says so on the tools that need a secret, refuses to save new
  secrets and retries every minute. `GET /api/secret-store` (Admin) shows which store is in use.
- **Accepted and snoozed findings**: with each tenant's scan results (`suppressions/<tool>.json`).
- **Other Settings page overrides and sign-in sessions**: under `DATA_DIR`. A sign-in ends after 8 hours without use
  and at the latest 24 hours after signing in. In Docker, map `DATA_DIR` to a volume, or every image update signs
  everyone out.
- **Cleanup savings** (orphaned resources deleted after they were found): `savings/orphaned-resources.json` per tenant.
- **Activity log** (scan runs): JSON lines in `runs.jsonl`, under `DATA_DIR/logs` when `DATA_DIR` is set, otherwise `./logs`.
- **Audit log** (who opened and changed what): `audit.jsonl` next to it, kept `AUDIT_RETENTION_DAYS`.

`.env`, `data/` and `logs/` are ignored by git; never commit real secrets.

## Keeping the stack up to date

- **Dependabot** (`.github/dependabot.yml`) opens weekly pull requests for npm packages (minor and patch grouped),
  the Node base image (not majors) and GitHub Actions. Each PR body has the release notes, and the image build with
  the Trivy gate runs on it before it is merged. Patch updates (and a new digest for the same Node image) merge by
  themselves once the build passes (`.github/workflows/dependabot-merge.yml`); minor and major updates wait for a
  person.
- **Weekly rebuild**: `docker.yml` also runs on Tuesdays, so the image picks up new Alpine and Node fixes and the
  merged updates, and the Trivy gate sees new CVEs. Promoting to `stable` stays a hand step.
- **CodeQL** (`.github/workflows/codeql.yml`) scans the JavaScript and the workflows on every push and weekly;
  findings go to the Security tab.
- **Stack report** (`.github/workflows/stack-report.yml`, Mondays, or Run workflow by hand) checks every part the
  dashboard is built on, the version in use against the newest, with the release notes in between (breaking changes,
  deprecations and security fixes marked at the top of each). It keeps one open issue labelled `stack-report` up to
  date and closes it when everything is current. It also covers what Dependabot skips: a newer Node LTS major and the
  Trivy scanner pinned by digest (it gives the new digest). Run it locally with
  `GITHUB_TOKEN=$(gh auth token) node .github/scripts/stack-report.mjs` (writes `stack-report.md`).

## Adding a tool

A scan tool is a file in `src/tools/` exporting `{ id, label, schedule, run() }`, where `run()` returns a list of
findings; register it with `registerScanTool` in `server.js` and add it to the `TOOLS` list in `public/app.js`
(each new finding kind gets a `KINDS` entry there and its controls in `public/compliance.js`). List what its
identity needs in `src/toolPermissions.js` (the server warns at start-up when a tool has no entry).
An on-demand tool exports `{ id, label, registerRoutes(app) }` and uses `registerActionTool`.

## Security

How to report a security problem and how to run Cirrus Watch safely: [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Gooseankles.

Cirrus Watch is free software under the [GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0-only).
You may use, change and share it; if you change it and let others use your version, also over a network, you must
offer them its source code under the same license. It comes with no warranty.
