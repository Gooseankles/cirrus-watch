# Cirrus Watch

A self-hosted dashboard for the everyday checks and chores of running an Azure tenant: nightly scans for waste,
risky access and broken policy, cost history per subscription and a "who has access to what" lookup.

It is a small Node.js (Express) app with a no-build front end. Run it locally with `npm start`, or as a container on
Azure App Service, where the [Terraform module](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard) sets up everything, including a managed identity, so no secrets
are needed.

## Tools

| Tool | Runs | What it finds or does |
|---|---|---|
| Orphaned resources | Daily | Unattached disks, unused public IPs, orphaned NICs, empty resource groups, old snapshots and snapshots of deleted disks, VMs stopped but not deallocated, empty App Service plans, idle NAT, VPN, ExpressRoute and application gateways, empty load balancers, disconnected private endpoints, unlinked private DNS zones, unused NSGs and route tables, empty availability sets and SQL elastic pools, backups still kept for VMs that were deleted (recovery points, protection state, fee plus a share of vault storage), each priced at list price where Azure publishes one; storage accounts with no lifecycle policy, workspaces with no daily cap (opt-in); Azure Advisor cost tips with Advisor's own estimate (settings: old snapshot age, Advisor tips on or off); **Cleaned up** lists the priced ones that were deleted since and what that saves (list price, so it works where cost analysis is off) |
| Tag compliance | Daily | Resources missing required tags (`CostCenter`, `Owner`, `Environment` by default) |
| Cost anomalies | Daily | Subscriptions whose spend jumped against their own recent baseline |
| Access review | Weekly | Long-standing Owner, Contributor and User Access Administrator grants, direct and through groups (nested groups shown as a tree) |
| Expiring app credentials | Daily | App secrets and certificates that expire soon; app registrations with no owner, with only client secrets, or with secrets valid longer than the set maximum (365 days by default) |
| Key Vault | Daily | Vault settings (soft delete, purge protection, open networks, access policies); secrets, keys and certificates that expired, expire soon or have no expiry date (optional, off unless turned on in Settings); who can read secrets (broad roles, many readers, guests, deleted identities); vaults with no audit log, no owner tag, nothing in them or no use |
| Access packages | Daily | Entra access packages that expire soon, wait too long for approval, go unused, auto-approve with no end date, have a single approver, or have approver groups with no (enabled) members, so requests cannot be approved |
| Role assignments | Daily | Assignments whose user, group or app was deleted, and subscriptions near Azure's limit of 4,000 role assignments |
| Policy check | Daily | Whether Azure Policy actually works: probes ask Azure if risky resources would be allowed (nothing is created), and health checks find assignments that cannot work (enforcement off, identity missing roles, remediation never run, expired exemptions and more) |
| Internet exposure | Daily | NSG rules open to the whole internet (admin, database or all ports), VMs with a public IP, storage containers anyone can read, database firewalls open to everyone or to all of Azure |
| End of support | Weekly | AKS Kubernetes versions out of support, App Service runtimes and VM operating systems past or near end of support, services that still accept TLS 1.0/1.1 |
| Service retirements | Daily | Azure features being retired that your resources still use (from Azure Advisor), with the date |
| Defender for Cloud | Daily | Subscriptions with a low secure score, unhealthy Defender recommendations (from medium severity by default) with how many resources each hits, Defender plans that are off but should be on, and plans on in some subscriptions but off in others |
| Safety nets | Daily | Subscriptions with no cost budget or a budget that alerts nobody (budgets set on a management group are not seen), and key vaults, backup vaults, VNets and DNS zones with no delete lock on them, their resource group or their subscription |
| Backup coverage | Daily | VMs with no backup, backups stopped, failing or too old, vaults without soft delete or with locally redundant storage (backups of deleted VMs are under Orphaned resources) |
| Resilience | Daily | What one failure would take down: single VMs with no zone or availability set, AKS clusters not in zones, with under 3 system nodes or on the free tier, App Service plans on one instance or not zone redundant, storage in one datacenter, public IPs, load balancers and gateways not zone redundant, legacy or standby-only VPN and ExpressRoute gateways, PostgreSQL and MySQL without geo-backup or zone HA, subscriptions with no Service Health alert. Each finding links to its PSRule for Azure rule |
| Resource settings | Daily | Risky settings: storage that accepts HTTP, is open to all networks or still takes access keys; SQL servers with no Entra admin or with SQL logins; web apps on HTTP, with remote debugging or plain FTP; registries with the admin user or anonymous pull; AKS with local accounts, no Entra sign-in, an API open to any IP or no auto-upgrade; Redis on its non-TLS port; Cosmos DB, Service Bus, Event Hubs and App Configuration with keys on. Each finding links to its PSRule for Azure rule |
| Exposure paths | Daily | Attack paths across resources: internet-facing VMs and web apps whose managed identity can take over a subscription or read key vaults and storage; whose subnet reaches databases, key vaults or resources tagged sensitive with no NSG or firewall in between; or from which SSH and RDP between subnets lead to such a machine. Also a subnet-to-subnet reachability map of each VNet. Built from NSG rules, routes and role assignments in Resource Graph |
| Azure Monitor | Daily | Machines with no agent, the legacy agent, no collection rule or no heartbeat; alert rules that are off, alert nobody or watch deleted resources; broken action groups; workspaces at their daily cap. Off per tenant for customers who do not use Azure Monitor |
| Updates and patching | Daily | Running VMs and Arc servers with Critical or Security updates pending (overdue after 30 days by default), machines not assessed in the last 7 days or whose assessment failed, VMs on no patch schedule, and failed or partly failed update installations, from Azure Update Manager |
| Resource health | Hourly | Resources Azure reports as Unavailable or Degraded now, active Azure outages, advisories and upcoming planned maintenance for your subscriptions |
| Network hygiene | Daily | WAF policies in Detection mode or off, WAF gateways with no WAF, public Standard gateways without WAF, dangling DNS records (CNAMEs to deleted Azure names that anyone can claim, aliases to deleted resources), routes to a virtual appliance address nobody has |
| Subscriptions | Daily | Subscriptions in the Tenant Root Group, with no Owner, or Warned, PastDue or Disabled |
| Diagnostic settings | Daily | Resources whose logs go nowhere, subscriptions whose activity log is not exported, NSG flow logs (retiring September 2027), VNets with no flow log |
| Quotas | Daily | Compute, network and storage quotas close to their limit in the regions you use |
| Firewall policies | Daily | Every Azure Firewall policy and classic firewall with its rule collection groups, collections and rules in the order the firewall checks them (parent policy first); exact duplicates, denies an earlier allow already lets through, allows an earlier deny already blocks, rules a wider rule already covers, application rules a network rule answers first, any-to-any and all-port allows, allow-all FQDNs, DNAT of admin ports from anywhere, missing IP groups, FQDN network rules without DNS proxy, unused or empty policies, threat intelligence off and IDPS off on Premium; a Rules view per policy with every rule marked and a search by name, FQDN, port or IP address; a Reach map that takes a VM or IP address and shows every rule that lets traffic in to it or out from it, downloadable as CSV, PNG or SVG |
| Architecture | Daily | A drawing of the environment: pick resource groups or subscriptions (or open a group and pick single resources) and the VNets and subnets their resources sit in are drawn by themselves (also from other resource groups), with NSG, route table, NAT and delegation marks, peerings (red when not connected), VPN and ExpressRoute sites, private endpoint links and public IPs; laid out hub and spoke (each hub VNet in the middle with its peered spokes around it and on-premises on its left; a plain Network layout is one click away) or by resource group; pan, zoom, search and a details panel; tiles carry Microsoft's Azure architecture icons (also in the downloads; terms in [public/icons/NOTICE.md](public/icons/NOTICE.md)); download as SVG, PNG or draw.io. Traffic lines: pick a port set (all ports, AD, RDP, SSH, SMB, SQL, web, WinRM or your own ports) and arrows show which drawn VMs can reach each other and the drawn private endpoints (blocked pairs on request); click a VM to see only its traffic in or out; a firewall the traffic passes through is always drawn and the lines go through it (firewall VMs get no lines of their own; each VM's lines can have its own colour, and pointing at a VM lights up its lines; over the whole drawing each VM has one line to the firewall with the number of pairs on it, and pairs in one subnet are left out unless asked for), following routes, NSGs on subnets and NICs and firewall network rules (also classic), with the blocking rule for each port. For information, no findings |
| IP addresses | Daily | Every VNet's address space and subnets with how full they are, and which addresses are taken and by what (shown on the **IPAM** page under Resources: free addresses per subnet, an address map, search by IP and a free range finder); overlapping ranges (also with on-premises VPN sites and Virtual WAN hubs), subnets running out, public or off-plan address space, VNets with no room left, broken or unsynced peerings; a finder for free ranges for a new VNet or subnet; firewall IP groups with their entries, what uses them and when they last changed (empty, unused, failed, nearly full, duplicate or untidy groups are findings), with a compare against a pasted on-premises list that gives the `az` command to bring a group up to date |
| Privileged roles | Daily | Too many or too few Global Administrators, guests, apps and disabled accounts in admin roles, permanent admin rights where PIM is used, admins with no MFA, too few working emergency access accounts |
| Entra tenant settings | Daily | Tenant settings that let any user register apps, create tenants or security groups, invite guests or join by email sign-up; guest access same as members; B2B direct connect open to every outside tenant |
| PIM | Daily | A PIM review: everyone who can activate an Entra or Azure role, directly or through a group (a group eligible for a role, or PIM for Groups membership of a group that holds one), with a CSV; the groups that give PIM access. Findings: PIM settings of privileged roles (activation without MFA, reason or approval, too long, permanent assignment allowed), guests and disabled accounts with PIM access, access that never ends, runs out soon or is never used, groups that are not role-assignable or have permanent members, permanent Azure Owners where PIM is used (needs Entra ID P2) |
| Stale accounts | Daily | Members and guests with no sign-in for 90 days, accounts that never signed in, guest invitations never accepted (needs Entra ID P1) |
| MFA coverage | Daily | Enabled members with no MFA method registered, and accounts that can only use phone or SMS (needs Entra ID P1) |
| Conditional Access | Daily | No MFA for everyone or for admins, legacy sign-in not blocked, report-only policies, long exclusion lists |
| App permissions | Daily | Apps with Graph permissions that could take over the tenant or read everyone's data, risky delegated consents, users allowed to consent to any app |
| Licence coverage | Daily | How many Entra ID P1, P2 and ID Governance licences are needed for the people using Conditional Access, PIM and access packages, against how many you own |
| Change log | Daily | What people and apps created, changed or deleted in the last 24 hours, security changes marked (for information; not in totals or the report) |
| Cost history | Daily | Daily cost per subscription plus monthly cost by service and resource group, kept for as long as you like |
| Access lookup | On demand | The Azure roles (every subscription and management group) and Entra ID roles a person or a group holds, and the ones they can activate with PIM (eligible; eligible Azure roles come from the last PIM scan, so a tenant with hundreds of subscriptions still answers fast), plus the groups they may join with PIM for Groups and the roles those give, directly or through groups. Nested groups show the whole chain, e.g. Ops team › Azure admins › Owners-Prod. Type part of a name and pick the person or group from the list (press Enter to search); a group also shows what it sits in and who is in it |

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
- **Compliance tags**: each finding shows the NIS2 Article 21(2) points, NSM ICT security principles (Norway's
  baseline, v2.1) and CIS Controls v8 safeguards it bears on (`public/compliance.js`), and the scan pages filter on
  them. A finding shows a control is not met somewhere; no finding does not prove it is met.
- **Compliance page** (`#/compliance`): every NIS2 point, NSM principle or mapped CIS safeguard for the tenant tab in
  view: critical findings, findings, no findings (the scans that look at it ran and found nothing), not run yet, or
  check by hand (training, incident handling, supplier contracts: things no scan can see). Each row links the scans
  that check it and when they last ran. **Print / PDF** as for the report. Built from the scans only; Microsoft
  Defender for Cloud is not needed.

## Quick start

### Docker

```
docker run -p 7070:7070 -e DASHBOARD_ADMIN_PASSWORD=<choose one> -e SESSION_SECRET=<long random string> \
  -e DATA_DIR=/app/data -v azure-ops-data:/app/data trozity/azure-ops-dashboard:latest
```

Open http://localhost:7070 and sign in as `admin`. Image tags: `latest` (every push to `main`), `stable` (promoted
by hand with the "Promote to stable" workflow once a build has proven itself), and each version (e.g.
`0.7.0.0`).

### From source

```
npm install
cp .env.example .env    # then fill it in
npm start
```

Uses Node.js 24 (the version the image is built on; the Azure libraries need 22 or newer). Set the Azure connection in `.env` or later on the dashboard's Settings page.

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
  source = "github.com/Gooseankles/terraform-azurerm-ops-dashboard?ref=v1.0.0"

  name     = "contoso-azure-tools"
  location = "norwayeast"
  image    = "trozity/azure-ops-dashboard:0.21.2.0" # the module tag pins the infrastructure, this pins the app

  shared_spn_access = [
    { scope = "/providers/Microsoft.Management/managementGroups/<tenant-id>" },
  ]
  admin_principal_ids = ["<group object id>"]
}
```

All inputs, the provider setup and what each one does are in the [module's README](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard#readme).
To let only some public IPs reach the site, set `allowed_ip_ranges` (see "Access restrictions" there).

## Signing in and roles

- **Admin**: everything, every tenant, plus Run now, cost history refresh and the Settings page.
- **User**: read-only, every tenant.
- **Admin-&lt;key&gt;**: one customer tenant (see "Customer tenants" below): read it and run its scans.
- **User-&lt;key&gt;**: one customer tenant, read-only.
- **&lt;Area&gt;.Read** / **&lt;Area&gt;.Run**: one area in every tenant, read-only or with Run now.
- **&lt;Area&gt;.Read-&lt;key&gt;** / **&lt;Area&gt;.Run-&lt;key&gt;**: one area in one tenant.

Areas let each team see only its own scans. Area is `Identity`, `Platform`, `Security` or `Cost`; a scan can sit in
more than one (`TOOL_AREAS` in `src/access.js`):

| Area | Scans |
| --- | --- |
| Identity | Access lookup, access review, secret expiry, access packages, role assignments, PIM, stale accounts, tenant settings, licence coverage, privileged roles, app permissions, Conditional Access, MFA coverage |
| Security | Privileged roles, app permissions, Conditional Access, MFA coverage, Defender for Cloud, internet exposure, exposure paths, firewall policies, network hygiene, Key Vault, resource settings, diagnostic settings, change log |
| Platform | Defender for Cloud, internet exposure, exposure paths, firewall policies, network hygiene, Key Vault, resource settings, diagnostic settings, change log, IPAM, tags, end of support, service retirements, backup coverage, resilience, updates, resource health, architecture, policy check, safety nets, Azure Monitor, subscriptions, quotas, orphaned resources, cost anomalies, cost history |
| Cost | Orphaned resources, cost anomalies, cost history |

Whoever may read a scan may also accept or snooze its findings. Settings, the server log lines and notifications
stay with `Admin` (and `User` for reading).

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
   roles you want (`Security.Read`, `Platform.Run-acme` and so on) (allowed member types: Users/Groups).
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
  automatically. Policy check, internet exposure, end of support, service retirements, Defender for Cloud, safety nets, backup coverage,
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
  customer's data never sits next to another's. Runs are kept for `HISTORY_RETENTION_DAYS` (default 365).
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
  the Trivy gate runs on it before it is merged.
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

## License

Copyright (C) 2026 Gooseankles.

Cirrus Watch is free software under the [GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0-only).
You may use, change and share it; if you change it and let others use your version, also over a network, you must
offer them its source code under the same license. It comes with no warranty.
