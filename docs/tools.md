# Scan tools

What each tool in Cirrus Watch checks. The first paragraph under each heading is also the row in the README's
tools table: `npm run docs` copies it there, and the docs check in CI fails when the two differ.

## Orphaned resources

Leftovers that cost money or clutter the tenant, priced at list price, and what cleaning up has saved.

Unattached disks, unused public IPs, orphaned NICs, empty resource groups, old snapshots and snapshots of deleted disks, VMs stopped but not deallocated, empty App Service plans, idle NAT, VPN, ExpressRoute and application gateways, empty load balancers, disconnected private endpoints, unlinked private DNS zones, unused NSGs and route tables, empty availability sets and SQL elastic pools, backups still kept for VMs that were deleted (recovery points, protection state, fee plus a share of vault storage), each priced at list price where Azure publishes one; storage accounts with no lifecycle policy, workspaces with no daily cap (opt-in); Azure Advisor cost tips with Advisor's own estimate (settings: old snapshot age, Advisor tips on or off); **Cleaned up** lists the priced ones that were deleted since and what that saves (list price, so it works where cost analysis is off).

## Tag compliance

Resources missing the tags you require.

Resources missing required tags (`CostCenter`, `Owner`, `Environment` by default).

## Cost anomalies

Resource groups whose cost yesterday jumped against the day before.

Compares each resource group's cost yesterday with its cost the day before, per subscription, and flags a jump of 50 % or more (`AZURE_COST_ANOMALY_THRESHOLD_PCT`).

## Access review

Long-standing Owner, Contributor and User Access Administrator grants, direct and through groups.

Long-standing Owner, Contributor and User Access Administrator grants, direct and through groups (nested groups shown as a tree).

## Expiring app credentials

App secrets and certificates that expire soon, and app registrations with risky credentials or no owner.

App secrets and certificates that expire soon; app registrations with no owner, with only client secrets, or with secrets valid longer than the set maximum (365 days by default).

## Key Vault

Vault settings, expiring vault items (optional) and who can read secrets.

Vault settings (soft delete, purge protection, open networks, access policies); secrets, keys and certificates that expired, expire soon or have no expiry date (optional, off unless turned on in Settings); who can read secrets (broad roles, many readers, guests, deleted identities); vaults with no audit log, no owner tag, nothing in them or no use.

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

## Certificates

TLS certificates of App Service custom domains and listed websites: expiry, name, trust and reachability.

TLS certificates of websites: the custom domains of App Service apps and slots found in Azure, plus any address listed in Settings (also sites outside Azure). Certificates that expired or expire soon (30 days by default), are not for the site's name, or have a chain browsers will not trust, and sites that do not answer over TLS.

## Defender for Cloud

Low secure scores, unhealthy recommendations and Defender plans that are off.

Subscriptions with a low secure score, unhealthy Defender recommendations (from medium severity by default) with how many resources each hits, Defender plans that are off but should be on, and plans on in some subscriptions but off in others.

## Vulnerabilities (CVEs)

Known vulnerabilities on machines and container images from Defender for Cloud, ranked by real-world exploitation.

One row per CVE and subscription with the resources it is on, from Defender for Cloud's vulnerability findings (machines through Defender for Servers or Defender CSPM, container images through Defender for Containers or Defender CSPM). CVEs on CISA's Known Exploited Vulnerabilities list are critical, then CVEs whose EPSS score says they are likely to be exploited soon (from 10% by default), then critical CVEs (the lowest severity listed is a setting). Each row says whether a fix is available. Subscriptions with machines or registries but no vulnerability assessment are flagged. The CISA list and EPSS scores are fetched once a day; only CVE ids are sent.

## Safety nets

Subscriptions with no working budget and key resources with no delete lock.

Subscriptions with no cost budget or a budget that alerts nobody (budgets set on a management group are not seen), and key vaults, backup vaults, VNets and DNS zones with no delete lock on them, their resource group or their subscription.

## Backup coverage

VMs with no backup, failing or old backups, and weak vault settings.

VMs with no backup, backups stopped, failing or too old, vaults without soft delete or with locally redundant storage (backups of deleted VMs are under Orphaned resources).

## Resilience

What one failure would take down: resources not spread over zones or instances.

What one failure would take down: single VMs with no zone or availability set, AKS clusters not in zones, with under 3 system nodes or on the free tier, App Service plans on one instance or not zone redundant, storage in one datacenter, public IPs, load balancers and gateways not zone redundant, legacy or standby-only VPN and ExpressRoute gateways, PostgreSQL and MySQL without geo-backup or zone HA, subscriptions with no Service Health alert. Each finding links to its PSRule for Azure rule.

## Resource settings

Risky settings on storage, SQL, web apps, registries, AKS, Redis and other services.

Risky settings: storage that accepts HTTP, is open to all networks or still takes access keys; SQL servers with no Entra admin or with SQL logins; web apps on HTTP, with remote debugging or plain FTP; registries with the admin user or anonymous pull; AKS with local accounts, no Entra sign-in, an API open to any IP or no auto-upgrade; Redis on its non-TLS port; Cosmos DB, Service Bus, Event Hubs and App Configuration with keys on. Each finding links to its PSRule for Azure rule.

## Exposure paths

Attack paths across resources, from internet-facing machines to what their identity and network can reach.

Attack paths across resources: internet-facing VMs and web apps whose managed identity can take over a subscription or read key vaults and storage; whose subnet reaches databases, key vaults or resources tagged sensitive with no NSG or firewall in between; or from which SSH and RDP between subnets lead to such a machine. Also a subnet-to-subnet reachability map of each VNet. Built from NSG rules, routes and role assignments in Resource Graph.

## Azure Monitor

Machines, alert rules, action groups and workspaces that Azure Monitor does not cover or that do not work.

Machines with no agent, the legacy agent, no collection rule or no heartbeat; alert rules that are off, alert nobody or watch deleted resources; broken action groups; workspaces at their daily cap. Off per tenant for customers who do not use Azure Monitor.

## Updates and patching

Machines with pending Critical or Security updates, missing assessments or failed installations.

Running VMs and Arc servers with Critical or Security updates pending (overdue after 30 days by default), machines not assessed in the last 7 days or whose assessment failed, VMs on no patch schedule, and failed or partly failed update installations, from Azure Update Manager.

## Resource health

Resources that are down or degraded now, Azure outages and planned maintenance.

Resources Azure reports as Unavailable or Degraded now, active Azure outages, advisories and upcoming planned maintenance for your subscriptions.

## Network hygiene

WAFs that block nothing, dangling DNS records and routes to nowhere.

WAF policies in Detection mode or off, WAF gateways with no WAF, public Standard gateways without WAF, dangling DNS records (CNAMEs to deleted Azure names that anyone can claim, aliases to deleted resources), routes to a virtual appliance address nobody has.

## Domains and mail

Off by default. The tenant's own domains: expiring registrations, no registrar lock, undelegated Azure DNS zones, SPF, DMARC and DKIM gaps.

Turned on per tenant with `DOMAIN_CHECKS` (`on`, or `dns` to skip the registration lookups); while off it makes no
requests. Domains come from member user names and mail addresses (Graph, `User.Read.All`), App Service custom host
names, Azure DNS zones and App Service Domains (Resource Graph); `*.onmicrosoft.com` and Azure default host names are
left out. Graph's own domain list is not used, since it needs `Domain.Read.All`. Registrable domains are found with a
short built-in list of multi-part suffixes (`co.uk`, `com.au`, `priv.no` and similar), not the full Public Suffix
List, so a domain under a rare one is looked up one level too high and quietly skipped. Checks:

- **Registration** (RDAP through `rdap.org`, which redirects to the registry; answers kept a day in
  `DATA_DIR/rdap-cache.json`): expired or expiring within 30 days (critical), within 60 days (warning), and no
  `clientTransferProhibited` or `serverTransferProhibited` status (information; generic TLDs only, as country
  registries often have no such status). A TLD without RDAP or without an expiry date (`.no`, `.de`) is skipped
  without a finding.
- **App Service Domains**: expiring (same limits) and auto-renew off.
- **Azure DNS zones** (public ones): the name servers public DNS gives for the zone do not match the zone's own
  (not delegated, delegated elsewhere or only partly).
- **Mail**, only for domains with MX records: SPF missing, more than one SPF record or ending in `+all` (critical),
  `?all` or more than 10 DNS lookups counted through includes (warning); DMARC missing or invalid (warning) or
  `p=none` (information; a subdomain without its own record uses its parent's `sp`/`p`); and for MX on
  `*.mail.protection.outlook.com`, missing `selector1`/`selector2._domainkey` DKIM records (information).

## Subscriptions

Subscriptions in the Tenant Root Group, with no Owner, or not in good standing.

Subscriptions in the Tenant Root Group, with no Owner, or Warned, PastDue or Disabled.

## Diagnostic settings

Resources and subscriptions whose logs go nowhere, and missing flow logs.

Resources whose logs go nowhere, subscriptions whose activity log is not exported, NSG flow logs (retiring September 2027), VNets with no flow log.

## Quotas

Compute, network and storage quotas close to their limit.

Compute, network and storage quotas close to their limit in the regions you use.

## Firewall policies

Every firewall rule in the order it is checked, the rules that are wrong or redundant, and a reach map per VM or IP.

Every Azure Firewall policy and classic firewall with its rule collection groups, collections and rules in the order the firewall checks them (parent policy first); exact duplicates, denies an earlier allow already lets through, allows an earlier deny already blocks, rules a wider rule already covers, application rules a network rule answers first, any-to-any and all-port allows, allow-all FQDNs, DNAT of admin ports from anywhere, missing IP groups, FQDN network rules without DNS proxy, unused or empty policies, threat intelligence off and IDPS off on Premium; a Rules view per policy with every rule marked and a search by name, FQDN, port or IP address; a Reach map that takes a VM or IP address and shows every rule that lets traffic in to it or out from it, downloadable as CSV, PNG or SVG.

## Architecture

A drawing of VNets, subnets and resources, with the traffic each VM can send (for information).

A drawing of the environment: pick resource groups or subscriptions (or open a group and pick single resources) and the VNets and subnets their resources sit in are drawn by themselves (also from other resource groups), with NSG, route table, NAT and delegation marks, peerings (red when not connected), VPN and ExpressRoute sites, private endpoint links and public IPs, what each managed identity may reach (its Azure roles on a resource or resource group and Key Vault access policies: a solid line when it reads or writes data, dashed when it manages the resource; roles on a whole subscription are left out) and which app registration signs people in to a web app (a redirect URI on the app's host name, drawn in a Microsoft Entra ID box; needs `Application.Read.All`), each with its own switch; laid out hub and spoke (each hub VNet in the middle with its peered spokes around it and on-premises on its left; a plain Network layout is one click away) or by resource group; pan, zoom, search and a details panel; tiles carry Microsoft's Azure architecture icons (also in the downloads; terms in [public/icons/NOTICE.md](../public/icons/NOTICE.md)); download as SVG, PNG or draw.io. Traffic lines: pick a port set (all ports, AD, RDP, SSH, SMB, SQL, web, WinRM or your own ports) and arrows show which drawn VMs can reach each other and the drawn private endpoints (blocked pairs on request); click a VM to see only its traffic in or out; a firewall the traffic passes through is always drawn and the lines go through it (firewall VMs get no lines of their own; each VM's lines can have its own colour, and pointing at a VM lights up its lines; over the whole drawing each VM has one line to the firewall with the number of pairs on it, and pairs in one subnet are left out unless asked for), following routes, NSGs on subnets and NICs and firewall network rules (also classic), with the blocking rule for each port. For information, no findings.

## IP addresses

Address space use, overlaps and free ranges (the IPAM page), and firewall IP groups.

Every VNet's address space and subnets with how full they are, and which addresses are taken and by what (shown on the **IPAM** page under Resources: free addresses per subnet, an address map, search by IP and a free range finder); overlapping ranges (also with on-premises VPN sites and Virtual WAN hubs), subnets running out, public or off-plan address space, VNets with no room left, broken or unsynced peerings; a finder for free ranges for a new VNet or subnet; firewall IP groups with their entries, what uses them and when they last changed (empty, unused, failed, nearly full, duplicate or untidy groups are findings), with a compare against a pasted on-premises list that gives the `az` command to bring a group up to date.

## Privileged roles

Who holds the powerful Entra roles and whether they are protected.

Too many or too few Global Administrators, guests, apps and disabled accounts in admin roles, permanent admin rights where PIM is used, admins with no MFA, too few working emergency access accounts.

## Entra tenant settings

Tenant settings that let any user register apps, invite guests or create tenants.

Tenant settings that let any user register apps, create tenants or security groups, invite guests or join by email sign-up; guest access same as members; B2B direct connect open to every outside tenant.

## PIM

Everyone who can activate a role, and PIM settings and assignments that are too loose.

A PIM review: everyone who can activate an Entra or Azure role, directly or through a group (a group eligible for a role, or PIM for Groups membership of a group that holds one), with a CSV; the groups that give PIM access. Findings: PIM settings of privileged roles (activation without MFA, reason or approval, too long, permanent assignment allowed), guests and disabled accounts with PIM access, access that never ends, runs out soon or is never used, groups that are not role-assignable or have permanent members, permanent Azure Owners where PIM is used (needs Entra ID P2).

## Stale accounts

Members and guests who have not signed in for a long time, or never.

Members and guests with no sign-in for 90 days, accounts that never signed in, guest invitations never accepted (needs Entra ID P1).

## MFA coverage

Enabled members with no MFA method, or only phone and SMS.

Enabled members with no MFA method registered, and accounts that can only use phone or SMS (needs Entra ID P1).

## Conditional Access

Gaps in Conditional Access policies.

No MFA for everyone or for admins, legacy sign-in not blocked, report-only policies, long exclusion lists.

## App permissions

Apps with Graph permissions that could take over the tenant, and risky consents.

Apps with Graph permissions that could take over the tenant or read everyone's data, risky delegated consents, users allowed to consent to any app.

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
