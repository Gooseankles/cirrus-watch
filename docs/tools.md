# Scan tools

What each tool in Cirrus Watch checks. The first paragraph under each heading is also the row in the README's
tools table: `npm run docs` copies it there, and the docs check in CI fails when the two differ.

## Orphaned resources

Leftovers that cost money or clutter the tenant, priced at list price, and what cleaning up has saved.

Unattached disks, unused public IPs, orphaned NICs, empty resource groups, old snapshots and snapshots of deleted disks, VMs stopped but not deallocated, empty App Service plans, idle NAT, VPN, ExpressRoute and application gateways, empty load balancers, disconnected private endpoints, unlinked private DNS zones, unused NSGs and route tables, empty availability sets and SQL elastic pools, backups still kept for VMs that were deleted (recovery points, protection state, fee plus a share of vault storage), each priced at list price where Azure publishes one; storage accounts with no lifecycle policy, workspaces with no daily cap (can be turned off); Azure Advisor cost tips with Advisor's own estimate (settings: old snapshot age, Advisor tips on or off); **Cleaned up** lists the priced ones that were deleted since and what that saves (list price, so it works where cost analysis is off).

## Tag compliance

Resources missing the tags you require.

Resources missing required tags (`CostCenter`, `Owner`, `Environment` by default).

## Cost anomalies

Resource groups whose cost yesterday jumped against the day before.

Compares each resource group's cost yesterday with its cost the day before, per subscription, and flags a jump of 50 % or more (`AZURE_COST_ANOMALY_THRESHOLD_PCT`).

## Access review

Long-standing Owner, Contributor and User Access Administrator grants, direct and through groups.

Long-standing Owner, Contributor and User Access Administrator grants, direct and through groups (nested groups shown as a tree).

Group members are read from Graph beta, because v1.0 leaves service principals (apps) out of group members; if
beta fails, v1.0 is used (apps are then missing). Access lookup's group view does the same.

## Expiring app credentials

App secrets and certificates that expire soon, and app registrations with risky credentials or no owner.

App secrets and certificates that expire soon; app registrations with no owner, with only client secrets, or with secrets valid longer than the set maximum (365 days by default); federated credentials whose subject has a wildcard or accepts any GitHub pull request (the first 300 apps are checked); redirect URIs on plain `http://` (other than localhost) or with a wildcard.

## Key Vault

Vault settings, expiring vault items and who can read secrets.

Vault settings (soft delete, purge protection, open networks, access policies); secrets, keys and certificates that expired, expire soon or have no expiry date (needs Key Vault Reader; can be turned off in Settings); who can read secrets (broad roles, many readers, guests, deleted identities); vaults with no audit log, no owner tag, nothing in them or no use.

## Access packages

Entra access packages that expire, wait for approval, go unused or cannot be approved.

Entra access packages that expire soon, wait too long for approval, go unused, auto-approve with no end date, have a single approver, or have approver groups with no (enabled) members, so requests cannot be approved.

## Role assignments

Assignments to deleted identities and subscriptions near the role assignment limit.

Assignments whose user, group or app was deleted, and subscriptions near Azure's limit of 4,000 role assignments.

## Policy check

Whether Azure Policy actually blocks risky resources, and assignments that cannot work.

Whether Azure Policy actually works: probes ask Azure if risky resources would be allowed (nothing is created), and health checks find assignments that cannot work (enforcement off, identity missing roles, remediation never run, expired exemptions and more).

## Internet exposure

NSG rules, VMs, storage and databases open to the internet.

NSG rules open to the whole internet (admin, database or all ports), VMs with a public IP, storage containers anyone can read, database firewalls open to everyone or to all of Azure.

## End of support

Kubernetes versions, runtimes, operating systems and TLS versions past or near end of support.

AKS Kubernetes versions out of support, App Service runtimes and VM operating systems past or near end of support (dates from endoflife.date, refreshed daily), services that still accept TLS 1.0/1.1.

## Service retirements

Azure features being retired that your resources still use, with the date.

Azure features being retired that your resources still use (from Azure Advisor), with the date.

## Azure news

What Microsoft announces for Azure: new features, previews and retirements, marked where your resources use them.

What Microsoft announces for Azure: new and generally available features, previews and retirements from the public Azure Updates feed, changed in the last 180 days or with a date still ahead. Updates about services your resources use are marked In use (from the Architecture scan's resource list). Chips pick New & GA, Preview, Retiring or In use; a product list and a search box narrow the rows, and each row links to Microsoft's page for it. Fetched once a day from `www.microsoft.com` with nothing about the tenant in the request; the last good copy stays when Microsoft cannot be reached. For information: no findings, and it needs no permission.

"In use" compares the products named on an update with a built-in list of the Azure resource types behind each
product (for example Azure Functions is a `microsoft.web/sites` resource whose kind says `functionapp`). A product
the list does not know is never marked. A tenant whose Architecture scan has not run yet shows as not known.
`RELEASE_FEEDS = off` (Settings → Upcoming) stops both Microsoft feeds; the pages then show the last kept copy.

## Microsoft 365 roadmap

What Microsoft plans for Microsoft 365: features in development, rolling out, or launched in the last 60 days.

What Microsoft plans for Microsoft 365: features in development, rolling out, or launched in the last 60 days, from the public Microsoft 365 roadmap, with product, release phase, platforms and expected month. Chips pick a status; a product list and a search box narrow the rows, and each row links to the roadmap page for it. The same list for every tenant, fetched once a day from `www.microsoft.com` with nothing about the tenant in the request. For information: no findings, and it needs no permission.

The tenant's own Message center posts (Microsoft Graph `ServiceMessage.Read.All`) are not read: that would need a new
permission.

## Certificates

TLS certificates of App Service custom domains, application gateways and listed websites: expiry, name, trust and reachability.

TLS certificates of websites: the custom domains of App Service apps and slots found in Azure, application gateways, plus any address listed in Settings (also sites outside Azure). Certificates that expired or expire soon (30 days by default), are not for the site's name, or have a chain browsers will not trust, and sites that do not answer over TLS.

Application gateways (`CERT_AZURE_GATEWAYS`, on by default): the expiry of every listener certificate an HTTPS listener uses and every trusted root certificate an HTTPS backend setting uses is read from the gateway's settings (Azure returns their public part, also for Key Vault references), so private gateways are covered without a connection. A listener certificate that points at one version of a Key Vault secret is flagged too: the gateway never picks up a renewed certificate. Every HTTPS listener is also opened over TLS on its frontend's address: the public IP first and the private IP too (it answers only when the dashboard runs in a network that reaches it; `CERT_PROBE_PRIVATE` off skips private IPs). A listener with a host name is opened with that name (SNI); a wildcard host name (`*.contoso.com`) with a made-up name it matches (`cirrus-watch-probe.contoso.com`), so the name is judged against the wildcard; a basic listener (no host name) with no SNI, and then no name is judged. The live answer can report a wrong name, an untrusted chain, or that the gateway serves another certificate than the one its settings name (`agw-cert-served-differs`, compared by thumbprint). For a Key Vault secret without a version it is not reported while a renewal is on its way: when the gateway already serves a newer certificate (later valid-from date) than the settings show, or when the certificate in the settings became valid less than 24 hours ago (the gateway picks up a renewal within 4 hours); the live check says so instead. Expiry is not reported again from the live answer. An address that does not answer is never a finding (many gateways let in only Front Door or known addresses); its row says "Not reachable from the dashboard". A Key Vault certificate whose public part Azure does not return is marked "Expiry not readable from the gateway settings": its expiry is then taken from the live answer (the worst one, reported once per certificate), or the row says it is not readable when no listener answered. Reading it from Key Vault itself would need a Key Vault data-plane permission, which the dashboard does not ask for.

Application gateways (a tab on the scan's page, `/api/certificates`): every running gateway with its addresses. Each gateway lists its public frontends (IP and DNS name) and private frontends, and its subscription name, then every listener (a table, or one card per listener on a narrow screen) with protocol, address and port, host names (wildcards and basic listeners shown as such), the certificate from the settings with its state, expiry and source, and what each address answered live (state, address, the name it was opened with, or "Not reachable from the dashboard").

In use (a tab on the scan's page, `/api/certificates`): every certificate the last scan saw, not only the ones with a finding. One row per web app custom domain, gateway listener certificate, gateway trusted root and listed address, plus every App Service certificate resource (`Microsoft.Web/certificates`) with the custom domains bound to it (matched by thumbprint against running apps; left out of a run whose web app query failed). Each row has where it is used, issuer, expiry and days left, the source (live connection, uploaded, Key Vault, Key Vault pinned to one version, App Service, trusted root) and a state: OK, expires soon, expired, wrong name, not trusted, no answer, not readable, or not used (a gateway certificate no listener or backend setting uses, an App Service certificate bound to no running app). Worst first. A gateway listener is listed from the gateway's settings, not again from its live connection; a Key Vault certificate the settings could not read takes its live answer (source "Key Vault, read live").

## Defender for Cloud

Low secure scores, unhealthy recommendations, Defender plans that are off, missing alert e-mails and open alerts.

Subscriptions with a low secure score, unhealthy Defender recommendations (from medium severity by default) with how many resources each hits, Defender plans that are off but should be on, and plans on in some subscriptions but off in others. Defender for Servers on Plan 1 where other subscriptions have Plan 2, and agentless machine scanning turned off in Servers Plan 2 or Defender CSPM. Security contacts that tell nobody about alerts: no contact or no address and role notifications off, alert e-mails off, or only role holders told (no e-mail address). Open High and Medium security alerts from Resource Graph, one row per alert type, subscription and severity with how many there are and the age of the oldest (High alerts are critical); at most 200 rows.

## Vulnerabilities (CVEs)

Known vulnerabilities on machines and container images from Defender for Cloud, ranked by real-world exploitation.

One row per CVE and subscription with the resources it is on, from Defender for Cloud's vulnerability findings (machines through Defender for Servers or Defender CSPM, container images through Defender for Containers or Defender CSPM). CVEs on CISA's Known Exploited Vulnerabilities list are critical, then CVEs whose EPSS score says they are likely to be exploited soon (from 10% by default), then critical CVEs (the lowest severity listed is a setting). Each row says whether a fix is available. Subscriptions with machines or registries but no vulnerability assessment are flagged. The CISA list and EPSS scores are fetched once a day; only CVE ids are sent.

## Safety nets

Subscriptions with no working budget and key resources with no delete lock.

Subscriptions with no cost budget or a budget that alerts nobody (budgets set on a management group are not seen), and key vaults, Recovery Services and backup vaults, VNets, DNS and private DNS zones, Log Analytics workspaces, SQL servers, AKS clusters and Azure Firewalls with no delete lock on them, their resource group or their subscription. The list of resource types is a setting (`LOCK_RESOURCE_TYPES`).

## Backup coverage

VMs with no backup, failing or old backups, and weak vault settings.

VMs with no backup, backups stopped, failing or too old, vaults without soft delete or with locally redundant storage (backups of deleted VMs are under Orphaned resources).

## Resilience

What one failure would take down: resources not spread over zones or instances.

What one failure would take down: single VMs with no zone or availability set, AKS clusters not in zones, with under 3 system nodes or on the free tier, App Service plans on one instance or not zone redundant, storage in one datacenter, public IPs, load balancers and gateways not zone redundant, legacy or standby-only VPN and ExpressRoute gateways, PostgreSQL and MySQL without geo-backup or zone HA, subscriptions with no Service Health alert. Each finding links to its PSRule for Azure rule.

## Resource settings

Risky settings on storage, SQL, web apps, registries, AKS, Redis and other services.

Risky settings: storage that accepts HTTP, is open to all networks or still takes access keys; SQL servers with no Entra admin or with SQL logins; web apps on HTTP, with remote debugging or plain FTP; registries with the admin user or anonymous pull; AKS with local accounts, no Entra sign-in, an API open to any IP or no auto-upgrade; Redis on its non-TLS port; Cosmos DB, Service Bus, Event Hubs and App Configuration with keys on. Most findings link to their PSRule for Azure rule. Cross-tenant replication allowed (warning, only when explicitly on) has no such rule. The access keys finding also says, while keys still work, whether a SAS expiration policy is missing and whether the portal defaults to the key instead of Entra ID sign-in. SQL TLS versions and SQL servers open to the internet are covered by End of support and Internet exposure.

## Exposure paths

Attack paths across resources, from internet-facing machines to what their identity and network can reach.

Attack paths across resources: internet-facing VMs and web apps whose managed identity can take over a subscription or read key vaults and storage; whose subnet reaches databases, key vaults or resources tagged sensitive with no NSG or firewall in between; or from which SSH and RDP between subnets lead to such a machine. Also a subnet-to-subnet reachability map of each VNet. Built from NSG rules, routes and role assignments in Resource Graph.

## Azure Monitor

Machines, alert rules, action groups and workspaces that Azure Monitor does not cover or that do not work.

Machines with no agent, the legacy agent, no collection rule or no heartbeat; machines whose data goes to a workspace no log alert reads; alert rules that are off, alert nobody or watch deleted resources; broken action groups; workspaces at their daily cap. Per tenant, Settings, Uses Azure Monitor: Auto (default) checks a tenant that has the Azure Monitor Agent or a data collection rule and skips the others; Yes always checks; No makes no request.

The page opens with one row of counts from the last scan: virtual machines, Arc servers and scale sets monitored out of all (the Azure Monitor Agent installed and not failed, at least one data collection rule and, where the heartbeat was read for a running machine, a recent one), with how many have no agent, only the legacy agent or no heartbeat; alert coverage; alert rules on out of all; data collection rules, action groups and workspaces.

**Alert coverage.** Log search alerts read one Log Analytics workspace, so a machine can have the agent and a data
collection rule and still never raise an alert, because its rule sends to another workspace. The scan takes the
workspaces in the scopes of the enabled log search alert rules (scheduled query rules of kind LogAlert; disabled
and log-to-metric rules do not count). A rule scoped to a subscription, resource group or machine (a
resource-centric log alert) reads the logs of the resources under it in any workspace, so it covers those machines
too (only its target resource types, when it names any). A running machine with a working agent whose collection
rules send only to other workspaces is flagged **No log alert reads its data** (`monitor-not-alerted`); a tenant
with no enabled log alert rule gets one such finding for the whole tenant. The **Alert coverage** tile counts the
machines (VMs and Arc servers) whose data a log alert reads, out of all; machines that send no logs (no working
agent, or no rule with a workspace destination) count as not covered, and a stopped VM or a disconnected Arc server
is judged by its setup, like the monitored count. The Machines tab has a **Workspace** column: where each machine
sends its data and whether a log alert reads it.

Covered means that an enabled log search alert reads a workspace the machine sends to, or has the machine in its
scope; not that a rule watches that machine. A rule's query can look at other computers or tables, and the scan
does not read queries. What the scan cannot see counts as no alert: rules in subscriptions it does not scan or in
another tenant, a rule that reads a second workspace through `workspace()` or `union` in its query text, and
Microsoft Sentinel analytics rules. Rules scoped to Application Insights or another resource that is not a
workspace cover nothing here, and metric, activity log and resource health alerts are a different kind and count
neither way. When the alerts live where the app cannot see them, set **Workspaces your alerts read**
(`AZURE_MONITOR_ALERT_WORKSPACES`, per tenant: comma-separated workspace names or resource IDs). It replaces the
workspaces taken from the rules; resource-scoped rules still count. A name matches every workspace with that name
in any subscription; give the resource ID when two share a name.

Each finding has a **How to fix** expander with short steps and a Microsoft Learn link; all of them, including how
to add the Azure Monitor Agent to one VM, many machines or from the CLI, are in
[Fixing Azure Monitor findings](guides/azure-monitor-fixes.md).

## Updates and patching

Machines with pending Critical or Security updates, missing assessments or failed installations.

Running VMs and Arc servers with Critical or Security updates pending (overdue after 30 days by default), machines not assessed in the last 7 days or whose assessment failed, VMs on no patch schedule, and failed or partly failed update installations, from Azure Update Manager.

## Resource health

Resources that are down or degraded now, Azure outages and planned maintenance.

Resources Azure reports as Unavailable or Degraded now, active Azure outages, advisories and upcoming planned maintenance for your subscriptions.

## Network hygiene

WAFs that block nothing, dangling DNS records and routes to nowhere.

WAF policies in Detection mode or off, WAF gateways with no WAF, public Standard gateways without WAF, dangling DNS records (CNAMEs to deleted Azure names that anyone can claim, aliases to deleted resources), routes to a virtual appliance address nobody has. Subnets with no NSG, unless every NIC or scale set in them has its own; GatewaySubnet, AzureFirewallSubnet, AzureFirewallManagementSubnet, AzureBastionSubnet, RouteServerSubnet and subnets delegated to NetApp volumes or BareMetal are left out.

## Connectivity health

VPN connections and ExpressRoute circuits that are down, failed gateways, stuck private endpoints and unhealthy backends.

Runs every hour. Site-to-site and VNet-to-VNet VPN connections that are not connected (live status from each
connection's own ARM GET), ExpressRoute circuits the provider has not provisioned or that are not enabled, and
circuits with Azure private peering disabled (critical). VPN and ExpressRoute gateways, including Virtual WAN ones,
in a failed provisioning state (critical). Private endpoints still waiting for approval (warning; rejected and
disconnected ones are in Orphaned resources) and approved private endpoints with no private DNS zone group, so the
name likely still resolves to the public address (information; turn this off in Settings, Connectivity health,
`CONNECTIVITY_PE_DNS_CHECK`, for tenants that run their own DNS). Backends that failed their health probes over the last hour, from Azure Monitor
metrics (warning): Application Gateway `UnhealthyHostCount` above 0, Standard load balancer health probe status
(`DipAvailability`) and Front Door origin health (`OriginHealthPercentage`, classic Front Door
`BackendHealthPercentage`) below 100 % (or `CONNECTIVITY_HEALTH_PERCENT`, set in Settings). Each finding names the pool, backend
or origin where Azure gives it and says what to check. Reads at most 500 connections, 500 private endpoints and
200 resources of each load-balancing kind per run; the rest show as "not checked".

## Azure Virtual Desktop

Session hosts that are down or forgotten, host pools that cost more than needed, and app groups users cannot see.

Session hosts that are Unavailable or Need assistance while they take new sessions (with the failed health checks),
not ready, shut down with no scaling plan or Start VM on Connect to start them, whose agent update failed, or left in
drain mode with no heartbeat for 7 days; host pools with no session hosts, pooled host pools with no scaling plan (or
one switched off), personal desktops assigned to nobody and personal pools with Start VM on Connect off; application
groups in no workspace (their users never see them) and workspaces with no application groups. Host pools,
application groups, workspaces and scaling plans come from Resource Graph, the session hosts from one ARM list per
host pool (at most 200 host pools a run, four at a time). A tenant with no host pools is skipped after one query: no
findings, and the page notes "No Azure Virtual Desktop" there. The Host pools tab lists each pool with its available
hosts, sessions, scaling plan and workspaces. Registration tokens are not checked (reading one needs write access),
nor the Windows client version of the hosts.

## Subscriptions

Subscriptions in the Tenant Root Group, with no Owner, not in good standing, or with classic administrators.

Subscriptions in the Tenant Root Group, with no Owner, or Warned, PastDue or Disabled. Classic administrators (Service Administrator and Co-Administrators) still listed: classic roles were retired in August 2024, and in December 2025 Azure gave the remaining ones an Owner role assignment on the subscription instead, so each entry is an Owner to review and a leftover to remove. Subscriptions where the list no longer answers (404) have none; one whose list is refused (403) is noted, not counted as a failure.

## Diagnostic settings

Resources and subscriptions whose logs go nowhere, and missing flow logs.

Resources whose logs go nowhere, subscriptions whose activity log is not exported, NSG flow logs (retiring September 2027), VNets with no flow log, Log Analytics workspaces whose default retention is under 90 days.

## Quotas

Compute, network and storage quotas close to their limit.

Compute, network and storage quotas close to their limit in the regions you use.

## Firewall policies

Every firewall rule in the order it is checked, the rules that are wrong or redundant, and a reach map per VM or IP.

Every Azure Firewall policy and classic firewall with its rule collection groups, collections and rules in the order the firewall checks them (parent policy first); exact duplicates, denies an earlier allow already lets through, allows an earlier deny already blocks, rules a wider rule already covers, application rules a network rule answers first, any-to-any and all-port allows, allow-all FQDNs, DNAT of admin ports from anywhere, missing IP groups, FQDN network rules without DNS proxy, unused or empty policies, threat intelligence off and IDPS off on Premium; a Rules view per policy with every rule marked and a search by name, FQDN, port or IP address; a Reach map that takes a VM or IP address and shows every rule that lets traffic in to it or out from it, downloadable as CSV, PNG or SVG.

## Architecture

A drawing of VNets, subnets and resources, with the traffic each VM can send and the firewall openings to on-premises and the Internet (for information).

A drawing of the environment: pick resource groups or subscriptions (or open a group and pick single resources) and the VNets and subnets their resources sit in are drawn by themselves (also from other resource groups), with NSG, route table, NAT and delegation marks, peerings (red when not connected), VPN and ExpressRoute sites, private endpoint links and public IPs, what each managed identity may reach (its Azure roles on a resource or resource group and Key Vault access policies: a solid line when it reads or writes data, dashed when it manages the resource; roles on a whole subscription are left out) and which app registration signs people in to a web app (a redirect URI on the app's host name, drawn in a Microsoft Entra ID box; needs `Application.Read.All`), each with its own switch; laid out hub and spoke (each hub VNet in the middle with its peered spokes around it and on-premises on its left; a plain Network layout is one click away) or by resource group; pan, zoom, search and a details panel; tiles carry Microsoft's Azure architecture icons (also in the downloads; terms in [public/icons/NOTICE.md](../public/icons/NOTICE.md)); download as SVG, PNG or draw.io. Traffic lines: pick a port set (all ports, AD, RDP, SSH, SMB, SQL, web, WinRM or your own ports) and arrows show which drawn VMs can reach each other and the drawn private endpoints (blocked pairs on request); click a VM to see only its traffic in or out; a firewall the traffic passes through is always drawn and the lines go through it (firewall VMs get no lines of their own; each VM's lines can have its own colour, and pointing at a VM lights up its lines; over the whole drawing each VM has one line to the firewall with the number of pairs on it, and pairs in one subnet are left out unless asked for), following routes, NSGs on subnets and NICs and firewall network rules (also classic), with the blocking rule for each port. Firewall openings (on by default, from the saved Firewall policies scan): what the Azure Firewall rules let through, as a tile per address, range, IP group, name, URL, FQDN tag or web category; an on-premises address sits under its ExpressRoute or VPN site (the site whose address space holds it, else the only connected site), an Internet address or name sits in an Internet box on the hub's right; the line follows the traffic hop by hop: from the VM, subnet or VNet the rule's source names (a VM when the source is its address or a small range, the subnet or VNet when the range covers it; a `*` source, or one spanning more than four VNets, starts at the firewall) through the firewall, then the gateway and the site for on-premises, to the tile; hops that several openings share are one line with a count (grey when openings to both sides share it), and the lines run under the tiles; a source outside Azure (a DNAT rule, or a named on-premises source) gives a line into Azure, to the DNAT's target or the rule's destination; a `*` rule is a red "Any address" tile on both sides; addresses inside a VNet, on-premises source ranges that also cover a VNet, and Deny rules are left out; click a tile for the path, the Azure side, the ports, direction and rules behind it (policy, collection group, collection, source and destination). For information, no findings.

## IP addresses

Address space use, overlaps and free ranges (the IPAM page), and firewall IP groups.

Every VNet's address space and subnets with how full they are, and which addresses are taken and by what (shown on the **IPAM** page under Resources: free addresses per subnet, an address map, search by IP and a free range finder); overlapping ranges (also with on-premises VPN sites and Virtual WAN hubs), subnets running out, public or off-plan address space, VNets with no room left, broken or unsynced peerings; a finder for free ranges for a new VNet or subnet; firewall IP groups with their entries, what uses them and when they last changed (empty, unused, failed, nearly full, duplicate or untidy groups are findings), with a compare against a pasted on-premises list that gives the `az` command to bring a group up to date.

## Privileged roles

Who holds the powerful Entra roles and whether they are protected.

Too many or too few Global Administrators, guests, apps and disabled accounts in admin roles, permanent admin rights where PIM is used, admins with no MFA, admin accounts synced from on-premises Active Directory (high for Global Administrators, medium for other roles), too few working emergency access accounts.

## Entra tenant settings

Tenant settings that let any user register apps, invite guests or create tenants.

Tenant settings that let any user register apps, create tenants or security groups, invite guests or join by email sign-up; guest access same as members; B2B direct connect open to every outside tenant; B2B guest invitations open to every outside tenant (Microsoft's default, so low); partner tenants whose MFA or device claims are trusted (information) or whose consent prompts are skipped. From the authentication methods policy: SMS or voice call allowed for all users, a Temporary Access Pass that may last more than a day (the default maximum is 8 hours; a reusable pass is Microsoft's default and not flagged), passkeys (FIDO2) turned off, migration from the old MFA and SSPR method lists not finished (information), the registration campaign turned off (information; Microsoft managed counts as on).

## PIM

Everyone who can activate a role, and PIM settings and assignments that are too loose.

A PIM review: everyone who can activate an Entra or Azure role, directly or through a group (a group eligible for a role, or PIM for Groups membership of a group that holds one), with a CSV; the groups that give PIM access. Findings: PIM settings of privileged roles (activation without MFA, reason or approval, too long, permanent assignment allowed), guests and disabled accounts with PIM access, access that never ends, runs out soon or is never used, groups that are not role-assignable or have permanent members, permanent Azure Owners where PIM is used (needs Entra ID P2).

## Stale accounts

Members and guests who have not signed in for a long time, or never.

Members and guests with no sign-in for 90 days, accounts that never signed in, guest invitations never accepted (needs Entra ID P1).

## MFA coverage

Enabled members with no MFA method, or only phone and SMS.

Enabled members with no MFA method registered, and accounts that can only use phone or SMS (needs Entra ID P1).

## Legacy sign-ins

Successful sign-ins with legacy clients that cannot do MFA.

Successful sign-ins in the last 7 days with legacy (basic authentication) clients: IMAP, POP, SMTP AUTH, Exchange ActiveSync, older Outlook protocols and "Other clients". One finding per user and client, with the count and the last time. Graph's sign-in list holds the interactive sign-ins, so legacy sign-ins Entra files as non-interactive are not seen and the counts are a floor; the client app field only takes an equals filter, so each client type is its own query, at most 3,000 sign-ins each (two at a time, since Entra allows five report requests per 10 seconds per tenant). Needs Entra ID P1 or P2 to read sign-in logs; without it the scan notes that in the log and reports nothing.

## Guest owners

Groups that a guest owns, so someone outside the organisation decides who is in them.

Every Entra group with a guest among its owners: a warning, critical when the group is role-assignable (it can hold Entra admin roles). The detail says when no member of the organisation owns the group. Runs with the default permissions (`GroupMember.Read.All`, `User.Read.All`). Owners of groups synced from on-premises and of distribution or mail-enabled security groups made in Exchange are not in Graph and are not seen. A check for privileged groups and roles with no access review was left out: review scopes are free-form queries in several shapes, so it could not be told reliably without many false findings.

## Risky users

Users Entra ID Protection marks as compromised or at high or medium risk, not yet dealt with.

Off until the tenant turns it on (Settings, Extra Graph checks: `risky-users`); needs the Graph permission `IdentityRiskyUser.Read.All` and Microsoft Entra ID P2. Users confirmed compromised and users at risk with a high risk level are critical, medium risk is a warning; remediated, dismissed, confirmed-safe, low-risk and deleted users are left out. Worst and longest left alone first, at most 50 findings (`RISKY_USERS_MAX`; the log says when more were found). Without P2 the scan writes an info line in the log and reports nothing.

## Administrative units

Guests or disabled accounts holding admin roles over an administrative unit, and restricted units that protect nothing.

Off until the tenant turns it on (Settings, Extra Graph checks: `admin-units`); needs the Graph permission `AdministrativeUnit.Read.All`. Only findings that show risk: a guest with an admin role scoped to an administrative unit (critical), a disabled account that still holds one (warning), a restricted management administrative unit with no members (information). Plain units, their sizes and dynamic rules are not reported: they carry no risk on their own and would only be noise. Scoped admins that are groups or apps are left to Privileged roles.

## Directory sync

Sync from on-premises Active Directory that has fallen behind or stopped.

Off until the tenant turns it on (Settings, Extra Graph checks: `directory-sync`); needs the Graph permission `Organization.Read.All`. Only for tenants that sync from on-premises (Microsoft Entra Connect Sync or Cloud Sync); cloud-only tenants report nothing. A warning when the last sync is older than 3 hours (`DIRECTORY_SYNC_MAX_HOURS`: Entra Connect syncs every 30 minutes, so 3 hours is six missed cycles, which rides out a server restart or an upgrade but not a stopped service), critical after 24 hours. Accounts disabled on-premises keep working in the cloud until sync runs again. Runs hourly (one small request).

## Microsoft Secure Score

The tenant's Microsoft Secure Score, a drop against last week, and the open actions worth the most points.

Off until the tenant turns it on (Settings, Extra Graph checks: `secure-score`); needs the Graph permission `SecurityEvents.Read.All`. This is Microsoft 365 and Defender XDR's Secure Score, not Defender for Cloud's. One information finding with the current score, a warning when it fell by 5 percentage points or more against the snapshot about a week older (`SECURE_SCORE_DROP_POINTS`, 0 turns it off), and the five open improvement actions with the most points left (information; actions marked as risk accepted or done by a third party are left out).

## Conditional Access

Gaps in Conditional Access policies.

No MFA for everyone or for admins, no authentication strength (phishing-resistant MFA) required for admins, legacy sign-in or the device code flow not blocked, admins (active members of privileged roles, directly or through a group) excluded from an enabled MFA or block policy by user, group or role, report-only policies, long exclusion lists. Report-only policies never count as enforcing. Accounts named in the emergency access setting may be excluded; with none named, a cloud-only Global Administrator excluded from every such policy is taken for an emergency access account.

## App permissions

Apps with Graph permissions that could take over the tenant, and risky consents.

Apps with Graph permissions that could take over the tenant or read everyone's data, apps registered here as multi-tenant that hold such a permission, risky delegated consents, users allowed to consent to any app.

## Enterprise apps

Enterprise apps with SAML certificates or service principal secrets that expire, open sign-in, no owner or no use.

Reads the service principals (enterprise apps), leaving out Microsoft's own apps and managed identities:

- **SAML signing certificate** of apps with SAML single sign-on: the active one (the Sign key matching the app's preferred signing thumbprint) expired or expires within 14 days (critical) or within the warning window of Expiring app credentials (`SECRET_EXPIRY_WARN_DAYS`, 30 days by default). Older, inactive certificates are left alone.
- **Credentials on the service principal itself**, which Expiring app credentials does not see (it reads app registrations): secrets and certificates that expired or expire, banded the same way, and live client secrets on this tenant's own apps (low).
- **Anyone can sign in**: SAML apps, and other companies' OpenID Connect apps, with single sign-on set up and "Assignment required" off, so every account in the tenant can sign in (low).
- **No owner**: enabled apps from this tenant with no owner on the enterprise app (low).
- **Unused**: other companies' apps with no sign-in for 90 days (`ENTERPRISE_APP_UNUSED_DAYS`), from the sign-in activity report (Graph beta, `AuditLog.Read.All`; skipped with a log line when it cannot be read) (low).
- **Disabled apps with Azure roles**: disabled service principals that still hold Azure role assignments, from Resource Graph (needs Reader; skipped with a log line otherwise).

## Licence coverage

Entra ID licences needed for the features in use, against those you own.

How many Entra ID P1, P2 and ID Governance licences are needed for the people using Conditional Access, PIM and access packages, against how many you own.

## Change log

What was created, changed or deleted in the last 24 hours (for information).

What people and apps created, changed or deleted in the last 24 hours, security changes marked (for information; not in totals or the report).

## Cost history

Daily cost per subscription and monthly cost by service and resource group.

Daily cost per subscription plus monthly cost by service and resource group, kept for as long as you like.

## Access lookup

Every Azure and Entra role a person or group holds or can activate, with the group chain.

The Azure roles (every subscription and management group) and Entra ID roles a person or a group holds, and the ones they can activate with PIM (eligible; eligible Azure roles come from the last PIM scan, so a tenant with hundreds of subscriptions still answers fast), plus the groups they may join with PIM for Groups and the roles those give, directly or through groups. Nested groups show the whole chain, e.g. Ops team › Azure admins › Owners-Prod. Type part of a name and pick the person or group from the list (press Enter to search); a group also shows what it sits in and who is in it.
