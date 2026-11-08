# Changelog

What changed in each version of Cirrus Watch, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are `major.minor.patch.build` (the `VERSION` file);
each one is also a Docker image tag (`trozity/azure-ops-dashboard:<version>`). The infrastructure has its own
changelog in the [Terraform module](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard/blob/main/CHANGELOG.md).

Versions before 0.47 are only in the git history.

## Upgrading

Steps needed when moving past a version. Read this before you change the image tag or the module version.

- **0.72.0.0: several scans were merged.** Each merged scan takes over the stored results, trends and accepted
  findings of the scans it replaced the first time it runs or is opened in a tenant, so nothing is reported as new
  just because the id changed. The newest 60 runs of the old scans can still be opened; older ones stay in the
  trend only. Not carried over, set them again where used: a tenant's scan switch (Settings, Scans) for an old scan
  id, and a per-tool identity override (`<TOOL_ID>_AZURE_CLIENT_ID` and friends) of an old id. The old files
  (`findings/<old id>.json`, `history/<old id>/`, `suppressions/<old id>.json`) can be deleted after a few days.
  Merged: Stale accounts, MFA coverage, Legacy sign-ins and Risky users → Accounts (`accounts`); Guest owners and
  Administrative units → Privileged roles (`privileged-roles`); End of support and Service retirements → End of life
  (`end-of-life`); Expiring app credentials and Enterprise apps → Applications (`applications`).

- **0.70.0.0: the Certificates scan opens TLS connections to application gateway private frontend IPs too.** It
  only gets an answer where the app's network reaches them (VNet integration, peering); elsewhere the row says "Not
  reachable from the dashboard" and nothing is reported. The first scan may bring new findings from listeners that
  were not opened before (basic listeners, wildcard host names, private frontends). No new permission. Set
  Open private gateway addresses to No (`CERT_PROBE_PRIVATE=off`) to open only public IPs.
- **0.70.0.0: checks that were off by default are now on.** The extra Graph checks (risky users, Secure Score,
  administrative units, directory sync), the Log Analytics daily cap check and the Key Vault item check run unless
  turned off, in every tenant. Each extra Graph check reports one scan error until its permission is granted (the
  module's `extra_graph_checks` now grants all four by default), and the Key Vault item check shows an error per
  vault without Key Vault Reader. To keep them off: Settings → Extra Graph checks `none` (or a list of the ones you
  want), and No for Log Analytics daily cap check and Key Vault item check (`EXTRA_GRAPH_CHECKS=none`,
  `LAW_DAILY_CAP_CHECK=off`, `KEYVAULT_ITEM_CHECK=off`).
- **0.70.0.0: Uses Azure Monitor has a new default, Auto.** A tenant that kept the old default (No) is now checked
  when it has the Azure Monitor Agent or a data collection rule, and the first scan may bring findings there. A
  customer tenant set to No stays off. In the home tenant, No was the default, so choosing it was not saved: choose
  No again after upgrading if the home tenant should stay off (or set `AZURE_MONITOR_IN_USE=off`).

- **0.69.0.0: Azure news and Microsoft 365 roadmap fetch from `www.microsoft.com` once a day.** A firewall or NAT
  that limits the app's outbound traffic (`vnet_route_all`) must allow HTTPS to that host, or set
  `RELEASE_FEEDS = off`; the pages then stay empty. No new permission.

- **0.68.0.0: the Domains and mail scan is gone.** Domain registration, DNS and mail records (SPF, DMARC, DKIM)
  are left to whoever runs the domains. A `DOMAIN_CHECKS` setting is ignored and can be removed, old findings from
  the scan drop out after the next scans, and `rdap-cache.json` in the data folder can be deleted.

- **0.65.0.0: images are signed, and Promote to stable only moves `stable` to a signed image.** 0.64.1.0 and older
  are unsigned and can no longer be promoted; the first signed version is the first one to promote. Promote to
  stable no longer calls deploy webhooks: it restarts the apps in the repo variable `STABLE_DEPLOYMENTS` through
  GitHub OIDC (module v1.10.0 `continuous_deployment`). Delete a `STABLE_DEPLOY_WEBHOOKS` secret if you made one.
- **0.65.0.0: Guest owners is a new default scan** and may bring new findings on its first run; it needs no new
  permission. The other new scans are off until a tenant lists them in Settings, Extra Graph checks
  (`EXTRA_GRAPH_CHECKS`), and each needs one more Graph permission: in the home tenant set the module's
  `extra_graph_checks`; a customer grants it with admin consent first. A newly granted permission can take up to
  24 hours to reach a managed identity; until then the scan shows which permission is missing.

- **0.64.1.0: `/api/me` needs a sign-in.** A script that called it without a session gets 401; use
  `/auth/methods` to ask which sign-in methods are set up.
- **0.64.0.0: the new Legacy sign-ins scan reads the sign-in log, which needs Entra ID P1 or P2.** Without it the
  scan notes the missing licence in the log and reports nothing; turn it off for such tenants. No new Graph
  permissions: everything the new checks read is already in the module's default `graph_permissions`.
- **0.61.1.0: the Azure Monitor heartbeat query goes to `api.loganalytics.azure.com`.** A firewall or NAT that
  limits the app's outbound traffic (`vnet_route_all`) must allow HTTPS to that host; otherwise the machine check
  reports the heartbeat query as failed. The roles stay the same (Reader, or Log Analytics Reader on the workspaces).
- **0.57.0.0: no more `<Area>.Run` roles.** Whoever may see a scan may run it. Old `<Area>.Run` and
  `<Area>.Run-<key>` roles still work and count as `<Area>.Read`, so nobody loses access, but their names now say
  more than they give. With Terraform, module v1.5.0 or newer drops the `.Run` app roles and groups and puts
  `run_members` into the matching `.Read` group; `run_members` is deprecated and will be removed in a later major
  version, so move those people to `read_members`.
- **0.55.0.0: requests that change something must come from the dashboard's own pages.** A script that posts to
  the API with an `Origin` header must use the dashboard's own address there; without the header it still works.
- **0.53.4.0: the image is built on Node.js 26.** Running from source needs Node.js 22 or newer; 26 is what is
  tested.

## [0.72.0.0] - 2026-11-08

### Changed

- A scan can replace older scans (`replaces` in its module): the store adopts the old scans' latest results,
  per-run history (the newest 60 runs as openable snapshots) and accepted findings under the new id the first
  time it is used in a tenant, keeping each finding's age, so the first run of the merged scan reports only real
  changes. See Upgrading.
- Stale accounts, MFA coverage, Legacy sign-ins and Risky users are one scan, **Accounts** (`accounts`, daily at
  05:30), with one finding per account. Before, an account nobody used was listed twice: as stale and as having no
  MFA (a tenant with 11,000 unused accounts also showed 11,000 accounts without MFA). Now an unused account is one
  stale finding whose detail says when it also has no MFA, and MFA is judged only for accounts in use (a sign-in
  inside the stale window; an account that never signed in has not registered a method yet). Expect the open count
  to drop by about the number of unused accounts that had no MFA. Finding kinds and ids are unchanged, so accepted
  findings carry over. The legacy sign-ins and risky users parts fail on their own (one scan-error finding each)
  without losing the account findings; the extra Graph check keeps its id `risky-users`. Settings: the stale and MFA
  fields are in one Accounts group; the Test lists the risky users permission as a part of Accounts.
- Guest owners and Administrative units are parts of **Privileged roles** (`privileged-roles`, daily at 05:00): groups
  owned by guests and the risky parts of administrative units are judged in the same scan as the admin roles, and
  each part fails on its own (one scan-error finding) without losing the role findings. Finding kinds and ids are
  unchanged, so accepted findings carry over; the extra Graph check keeps its id `admin-units`, and the Test lists
  `AdministrativeUnit.Read.All` as a part of Privileged roles.
- End of support and Service retirements are one scan, **End of life** (`end-of-life`, weekly on Monday at 06:00):
  software past or near end of support and Azure features being retired, in one place under Upcoming. The
  retirement check is a fifth part beside AKS versions, App Service runtimes, TLS settings and VM operating
  systems, each failing on its own; it ran daily before and now runs weekly with the rest (Advisor's retirement
  dates are months ahead). Finding kinds and ids are unchanged, so accepted findings carry over. Settings: the three
  fields (`EOS_LIVE_DATES`, `EOS_WARN_DAYS`, `RETIREMENT_WARN_DAYS`) are in one End of life group.
- Expiring app credentials and Enterprise apps are one scan, **Applications** (`applications`, daily at 05:20, under
  Identity): app registrations (expiring secrets and certificates, no owner, secret-only sign-in, long-lived secrets,
  broad federated credential subjects, insecure redirect URIs) and enterprise apps (SAML signing certificates,
  credentials on the service principal, open sign-in, no owner, unused third-party apps, disabled apps with Azure
  roles) in one place; the two shared the warning window already. Three parts, each failing on its own. Finding kinds
  and ids are unchanged, so accepted findings carry over. Settings: `SECRET_EXPIRY_WARN_DAYS`, `APP_SECRET_MAX_DAYS`
  and `ENTERPRISE_APP_UNUSED_DAYS` are in one Applications group.

## [0.71.5.0] - 2026-11-06

### Fixed

- Access lookup showed `Entra roles could not be read: Graph GET https://graph.microsoft.com/…` and no Entra roles,
  held or eligible: the note began with the Graph request address (a filter with fifteen ids) and was cut before
  the reason, and when Graph refused the batched read of the held roles the lookup gave up on the eligible ones too.
  Both reads now fall back to one call per principal when Graph refuses the batched shape with a 400, as the
  eligible read has since 0.70.4.0; the notes give Graph's status and message without the address, and the whole
  error (address and request ids) goes to Recent activity.

## [0.71.4.0] - 2026-11-05

### Changed

- Architecture drawing, firewall openings: a picked VM keeps only the rules that name its address or its subnet, plus
  the `*` rules. A rule written for the VM's whole VNet or a wider range (10.0.0.0/8, an IP group of spoke ranges)
  names the VNet, not the VM: it is drawn when that VNet is picked through its resource group (with the rules naming
  its subnets) or with All. On a real policy, where most rules are written for whole networks, one picked VM no longer
  brings nearly every opening. The VM's details panel counts those rules separately ("over its whole VNet or a wider
  range, not drawn for it alone"), and the openings data marks a VNet entry that is the VNet's own range (`own`).
- Architecture drawing, firewall openings: the openings data names every place a rule covers (200 per rule and a
  thousand per tile, was 24), so a rule naming many subnets or addresses through an IP group still names the picked
  one, and a tile with more rules than it lists is checked against all of them instead of being kept unchecked. The
  place ids go over the wire once, in a table, so the response does not grow with it.

## [0.71.3.0] - 2026-11-05

### Changed

- Architecture drawing, firewall openings: the tiles follow what is picked. A tile is drawn when a rule names a
  picked resource (its address or its subnet) or a subnet of a VNet picked through its resource group, or, with a
  picked VM on the drawing, when the rule covers the VM's whole VNet or is open to every Azure address. The hub alone
  (its firewall, gateways and bastion) no longer fills the drawing with every `*` rule or every rule written for the
  whole network; nothing picked draws no openings, All draws every opening, and the legend says how many are hidden.
  A bastion or private endpoint clicked keeps only the rules that name it or its subnet.

## [0.71.2.1] - 2026-11-05

### Added

- The docs are mirrored to the repository wiki after every change on main (`wiki.yml`, `scripts/wiki-sync.mjs`): one
  wiki page per docs page, Home and a sidebar from `docs/README.md`, links rewritten. Edit `docs/`, not the wiki.

## [0.71.2.0] - 2026-11-05

### Added

- Architecture drawing, firewall openings: with a VM picked (or any resource in a subnet), only the openings it can
  use stay on the drawing: those whose rules name it (its address, a range that covers it, its subnet or its VNet)
  and those open to every Azure address (a `*` source, or a range over most of the network with its VNet among
  them). Tiles and lines for everything else go, a legend line says how many stayed and how many are hidden, and the
  picked VM's lines stay lit. A tile picked after that keeps the filter; empty space brings every opening back.
- Firewall openings: a rule whose source spans more than four VNets now names those VNets, so the drawing can tell
  whether a picked VM is under it.

## [0.71.1.0] - 2026-11-05

### Fixed

- Architecture drawing, firewall openings: pointing at a VM lit the lines of every VM that reaches the same opening,
  and an opening's rule list gave no way to tell which rule names which VM, so a VM looked tied to rules whose
  source is another machine. Each VM's line to the firewall now lights only for that VM, and every rule on a tile
  carries its own Azure side (the VMs, subnets or VNets it names, with the address or range that names them).

### Added

- Architecture drawing: clicking a VM (or any resource in a subnet) lists the firewall openings whose rules name it,
  each with the rule and how it is named (its address, a range that covers it, its subnet or its VNet), and counts
  the openings open to every Azure address; the picked tile's lines stay lit. The tile's rule table has an
  Azure side column per rule.

## [0.71.0.1] - 2026-11-05

### Changed

- Documentation: `main` now takes only pull requests, admins included, with the docs checks required too;
  CONTRIBUTING.md describes the branch-and-pull-request flow and the merge settings (squash or rebase, linear history).

## [0.71.0.0] - 2026-11-05

### Added

- The Architecture drawing shows the firewall openings: what the Azure Firewall rules let through to on-premises
  and to the Internet, drawn hop by hop along the traffic's path. Each allowed on-premises address, range or IP
  group gets a tile under its ExpressRoute or VPN site, and a line runs from the VM, subnet or VNet the rule names
  through the firewall and the gateway to the site and on to the tile. Each Internet address, name, URL, FQDN tag
  or web category gets a tile in an Internet box on the hub's right, with the line running from the VM through the
  firewall. Hops that several openings share are one line with a count; a hop shared by openings to both sides is
  grey. A `*` rule shows as a red "Any address" tile on both sides; a rule whose source is `*` or spans most of
  the network starts its line at the firewall. Click a tile for the path, the Azure side and the rules behind it
  (policy, collection, ports, direction). Reads the saved Firewall policies scan; on by default, switch "Firewall
  openings" in the drawing's toolbar. Lines are now drawn under the tiles, so they no longer cross tile text.

## [0.70.5.0] - 2026-11-04

### Changed

- The overview shows the scans with the most critical findings first, then the most warnings, then the most open
  findings; ties keep the menu order. The kind badges on each card are listed worst first too.

### Security

- Hardening from the CodeQL code scanning alerts (none could be used from outside):
  - Requests with the Resource Manager or Log Analytics token go only to `management.azure.com` and
    `api.loganalytics.azure.com`; any other host is refused before the request.
  - Subscriptions to scan (`AZURE_SUBSCRIPTION_IDS`) must be subscription IDs (GUIDs) when saved in Settings.
  - A failed sign-in logs the request ID header with only ID characters, and never as the format string.
  - The secret expiry check for GitHub federated credentials matches the issuer exactly.
  - Azure Monitor trims trailing slashes without a regular expression that slows down on long input.
  - Restoring a removed tenant only accepts a key that was really removed.
  - Removing a tenant's log lines no longer checks that the log exists before reading it.

## [0.70.4.0] - 2026-11-04

### Fixed

- Access lookup said "Eligible (PIM) roles could not be read; that needs Entra ID P2" in tenants that have P2: any
  failure of that read was put down to the licence. When Graph refuses the batched call with a 400 (several principals in one
  filter, the role expanded), it now reads each principal on its own and looks the role names up. The note for
  eligible Entra roles and for PIM for Groups now gives the real reason: P2 only when Graph says the tenant lacks
  it, the missing permission on a 403, otherwise Graph's error.

## [0.70.3.0] - 2026-11-04

### Fixed

- The Network hygiene scan failed with "InvalidQuery; ParserFailure at \"=\" (line 7, char 22)": the query for
  network interfaces and scale sets with an NSG of their own (used by the subnets without NSG check) named a column
  inside `distinct`, which Resource Graph refuses. A test now looks for that shape in every scan's queries.

## [0.70.2.0] - 2026-11-03

### Fixed

- Azure news and Microsoft 365 roadmap showed 0 in the menu and on the overview card, since they make no findings.
  Both now show how many items the list has (`GET /api/azure-updates?count=1` and `/api/m365-roadmap?count=1`),
  the card says where the list comes from instead of "+0 new −0 resolved", and the Upcoming section's folded total
  still counts only open findings.

## [0.70.1.0] - 2026-11-03

### Fixed

- PIM: fewer "groups with roles checked for members not checked … (429) Too Many Requests" errors in large tenants.
  Each group's PIM for Groups requests go one after another instead of three at once. When Graph still throttles a
  group's activation history after the retries, the group is checked without it and the page says so: access
  through that group is not judged unused that run. A 429 on the group's eligible or active list still counts the
  group as not checked.

## [0.70.0.0] - 2026-11-02

### Added

- Certificates: an Application gateways tab. Every running application gateway with its addresses: public
  frontends (IP and DNS name) and private frontends, then every listener with protocol, address and port, host
  names (wildcards and basic listeners shown as such), the certificate from the settings with its state and expiry,
  and what each address answered live. On a phone each listener is a card instead of a table row. An address that does not answer says "Not reachable from the dashboard".
- Certificates: a new finding, Gateway serves another cert (`agw-cert-served-differs`), when a listener answers
  with another certificate than the one its settings name. For a Key Vault secret without a version it waits for
  a renewal: not reported while the gateway already serves a newer certificate than the settings show, or while
  the certificate in the settings is less than 24 hours old.

- Settings, Scans: Subscriptions to leave out (`EXCLUDED_SUBSCRIPTIONS`, per tenant). No scan reads the subscriptions
  listed (they are taken out of the per-subscription list and the Resource Graph scope) and their findings drop out
  at the next scan.
- Settings, Certificates: Open private gateway addresses (`CERT_PROBE_PRIVATE`, Yes by default). No opens only the
  public frontend IPs; expiry from the gateway settings is checked either way.

### Changed

- The extra Graph checks, the Log Analytics daily cap check and the Key Vault item check are on by default and can
  be turned off. Extra Graph checks takes `none` to turn them all off; blank means all, also in a customer tenant.
- Certificates: more gateway listeners are opened live. Basic listeners (no host name) are opened on the frontend
  IP with no SNI, with no name check; wildcard host names with a made-up name the wildcard matches; private
  frontend IPs are tried too. No answer is still never a finding, and expiry is still reported once, from the
  settings.
- Certificates: a Key Vault certificate whose expiry the gateway settings do not give is marked so, takes its
  expiry from the live answer (one finding per certificate, source "Key Vault, read live"), or says it is not
  readable when no listener answered. A live-read expiry finding now has the certificate's id, not the listener's,
  so such a finding that was accepted or snoozed before shows again once.
- Azure Monitor: Uses Azure Monitor (Settings, per tenant) has a new default, Auto. It checks a tenant that has the
  Azure Monitor Agent or a data collection rule (one Resource Graph query per scan) and skips the others; the page
  says which tenants Auto skipped. Before, the scan found nothing until the setting was changed to Yes.
- PIM: when each person last activated an Entra role now comes from PIM activation events in the directory audit
  log (`AuditLog.Read.All`, already granted), as far back as the tenant keeps it (30 days with Entra ID P1 or P2).
  PIM's own request list, read before, takes only a ReadWrite permission, so the unused-eligibility check was
  refused. With a 30-day audit log, unused Entra role eligibility is judged only when Eligibility is unused after
  (`PIM_UNUSED_DAYS`) fits in it; the PIM page says so. Azure roles and PIM for Groups are judged as before.

### Fixed

- Settings: on a phone a long choice (Check web apps found in Azure) no longer runs past the edge of the card.
- PIM: unused eligibility is judged only on the activation history of its own kind (Entra roles, Azure roles, PIM
  for Groups) when that history reaches back over the whole window. Before, a long Azure history could stand in
  for a short Entra one.
- PIM: a deleted user, group or app among the ids being looked up made Graph refuse the whole batch
  (`Request_ResourceNotFound`), which showed as a scan error. Such a batch is now looked up one id at a time and
  the deleted ones are left out.

## [0.69.0.0] - 2026-11-01

### Added

- Azure news: what Microsoft announces for Azure (new and generally available features, previews and
  retirements) from the public Azure Updates feed, changed in the last 180 days or with a date still ahead. Updates
  about services your resources use are marked In use, from the Architecture scan's resource list. Chips for All,
  New & GA, Preview, Retiring and In use, a product list, a search box and a link to Microsoft's page per update.
  Read route `/api/azure-updates`.
- Microsoft 365 roadmap: features in development, rolling out, or launched in the last 60 days, from the public
  Microsoft 365 roadmap, with status chips, a product list, a search box and a link to the roadmap page per feature.
  Read route `/api/m365-roadmap`.
- Both run daily early in the morning and fetch once a day from `www.microsoft.com` with nothing about the tenant
  in the request. The last good copy is kept (`release-feeds.json` in the data folder) and the page says when it
  was fetched. `RELEASE_FEEDS = off` (Settings, Upcoming) stops both calls. Neither needs a permission, and neither
  makes findings.

### Changed

- A new Upcoming group in the sidebar, after Cost, holds End of support, Service retirements, Azure news and
  Microsoft 365 roadmap. End of support and Service retirements keep their ids, findings and settings.

## [0.68.0.0] - 2026-11-01

### Removed

- The Domains and mail scan (domain expiry, App Service Domain renewal, DNS zone delegation, SPF, DMARC and DKIM).
  Domains and mail records are not the dashboard's job. The app no longer sends anything to public DNS or `rdap.org`.

## [0.67.0.0] - 2026-10-31

### Added

- Certificates has an "In use" tab: every certificate the last scan saw, also the healthy and unused ones, with
  where it is used (web app domain, gateway listener, gateway trusted root, listed address), the issuer, the expiry
  date with days left, the state (OK, expires soon, expired, wrong name, not trusted, no answer, not readable, not used) and where
  it comes from (live connection, uploaded, Key Vault, App Service, trusted root). App Service certificate resources are listed too, with the
  custom domains they are bound to. Read route `/api/certificates`. Needs only Reader, as before.

## [0.66.0.0] - 2026-10-31

### Added

- Certificates checks application gateways (`CERT_AZURE_GATEWAYS`, on by default): listener and trusted root
  certificates that expired or expire soon, read from the gateway's settings, so private gateways count too.
  Listener certificates pinned to one version of a Key Vault secret are flagged, since renewals never reach the
  gateway. Public HTTPS listeners with a host name are also opened over TLS for a wrong name or untrusted chain.
  Needs only Reader, as before.

### Changed

- Settings: the per-tool SPNs sit in one closed "Per-tool SPNs (advanced)" section at the bottom of the Home tab, with
  a count of the tools that have their own.

## [0.65.0.0] - 2026-10-31

### Added

- Guest owners scan (daily): groups owned by guest accounts, critical when the group can hold Entra roles.
- Extra Graph checks, off until a tenant turns them on (`EXTRA_GRAPH_CHECKS`, per tenant; a customer tenant never
  takes the home tenant's list):
  - Risky users: accounts confirmed compromised or at high or medium risk and not remediated (Entra ID P2,
    `IdentityRiskyUser.Read.All`; at most `RISKY_USERS_MAX`, 50).
  - Microsoft Secure Score: the current score, a drop of `SECURE_SCORE_DROP_POINTS` (5) or more in a week, and the
    five open actions worth the most points (`SecurityEvents.Read.All`).
  - Administrative units: guests or disabled accounts holding admin roles over a unit, and restricted units with no
    members (`AdministrativeUnit.Read.All`).
  - Directory sync (hourly): on-premises sync late by `DIRECTORY_SYNC_MAX_HOURS` (3) or stopped for a day
    (`Organization.Read.All`).
  - A scan that is on but lacks its permission shows one entry naming the permission.

### Security

- Images are signed with Sigstore cosign (keyless, by digest). SECURITY.md shows how to check one before you run or
  pin it.
- Promote to stable checks the signature before it moves `stable`.
- Promote to stable restarts apps through GitHub OIDC instead of deploy webhooks that carried the publishing
  password.
- CodeQL is a required check on `main`, next to the image build.

### Changed

- Docs: ADR 0009, the build, release and update diagrams, HLD and LLD.

## [0.64.1.0] - 2026-10-31

### Changed

- Every `/api/` route needs a sign-in, `/api/me` too. The login page asks the new `/auth/methods`, which says only
  which sign-in methods are set up.
- The pushed image carries an SBOM next to its build provenance, and every GitHub Action is pinned by commit.

### Fixed

- The PIM export guards cells against Excel formulas, like the other CSV exports.
- The architecture details panel escapes the resource type label.

### Security

- Saving, changing or removing a notification link and sending a test message go to the audit log, with the link's
  host name only, never the link.
- After 50 wrong local admin passwords from all addresses in 15 minutes, every address that sent one is refused until
  the window ends. An address with none still signs in, and Microsoft sign-in is not affected.
- Sign-in routes are matched exactly, so a later route that starts the same way still needs a sign-in.
- A failed Microsoft sign-in shows a short reference instead of the error; the detail is in the server log.

## [0.64.0.0] - 2026-10-31

### Added

- Legacy sign-ins, a new daily scan: successful sign-ins in the last 7 days with IMAP, POP, SMTP AUTH, Exchange
  ActiveSync, older Outlook protocols or "Other clients", one finding per user and client.
  [Legacy sign-ins](docs/tools.md#legacy-sign-ins)
- Subscriptions: classic administrators still listed on a subscription. [Subscriptions](docs/tools.md#subscriptions)
- Defender for Cloud: Servers on Plan 1 while other subscriptions have Plan 2, agentless scanning off, security
  contacts that tell nobody, and open High and Medium alerts. [Defender for Cloud](docs/tools.md#defender-for-cloud)
- Resource settings: storage accounts that allow cross-tenant replication.
  [Resource settings](docs/tools.md#resource-settings)
- Diagnostic settings: workspaces that keep logs for less than 90 days.
  [Diagnostic settings](docs/tools.md#diagnostic-settings)
- Network hygiene: subnets without a network security group, skipping reserved subnets.
  [Network hygiene](docs/tools.md#network-hygiene)
- Entra tenant settings: guests allowed from any tenant, partners whose MFA or devices are trusted, partners that
  skip consent, and from the authentication methods policy SMS or voice for all users, long Temporary Access Passes,
  passkeys off, method migration not done and the MFA registration campaign off.
  [Entra tenant settings](docs/tools.md#entra-tenant-settings)
- Conditional Access: admins excluded from MFA or block policies (accounts in `BREAK_GLASS_ACCOUNTS` may be), device
  code flow not blocked, and no strong MFA required for admins. [Conditional Access](docs/tools.md#conditional-access)
- Privileged roles: admin accounts synced from on-premises AD. [Privileged roles](docs/tools.md#privileged-roles)
- App registrations: broad federated credential subjects, unsafe redirect URIs, and multi-tenant apps that hold a
  high-impact permission. [Expiring app credentials](docs/tools.md#expiring-app-credentials),
  [App permissions](docs/tools.md#app-permissions)

### Changed

- Safety nets: Log Analytics workspaces, SQL servers, AKS clusters and Azure Firewalls are in the default delete-lock
  list. [Safety nets](docs/tools.md#safety-nets)
- "Storage access keys on" also says when a SAS expiration policy is missing and when the portal opens data with the
  key instead of Entra ID. [Resource settings](docs/tools.md#resource-settings)
- Conditional Access also reads role members, users and group members (permissions already granted) for the admin
  exclusion check. [Permissions](docs/permissions.md)

## [0.63.0.0] - 2026-10-31

### Added

- Azure Monitor checks that machines send their data where the alerts look. Log search alerts read one Log
  Analytics workspace, so a machine with the agent and a data collection rule that sends to another workspace never
  raises them. New finding **No log alert reads its data** (`monitor-not-alerted`) for such a running machine, with
  "How to fix" steps; a tenant with no enabled log alert rule at all gets one finding instead of one per machine.
  Rules scoped to a subscription, resource group or the machine itself (resource-centric log alerts) cover the
  machines under them whatever the workspace. Disabled rules and log-to-metric rules do not count. Covered means a
  log alert reads the workspace, not that its query watches that machine; rules the app cannot see (other
  subscriptions or tenants, Sentinel) count as none ([Azure Monitor](docs/tools.md#azure-monitor) lists the limits).
- New setting **Workspaces your alerts read** (`AZURE_MONITOR_ALERT_WORKSPACES`, per tenant, Settings > Azure
  Monitor): workspace names or resource IDs to check against instead of the workspaces the log alert rules are
  scoped to, for alerts the app cannot see.
- An **Alert coverage** tile (machines whose data an enabled log alert reads, out of all VMs and Arc servers) and a
  **Workspace** column on the Machines tab, showing where each machine sends its data and whether a log alert reads
  it; the tab also says which workspaces the log alerts read. Inventories saved before this version show none of
  this until the next scan.

## [0.62.0.0] - 2026-10-31

### Added

- "How to fix" steps on Azure Monitor findings: each finding opens a few short steps and a Microsoft Learn link
  under its detail. For a machine with no agent they cover one VM in the portal, many machines with Azure Policy,
  the Azure CLI, and what the machine needs first. All of them are in
  [Fixing Azure Monitor findings](docs/guides/azure-monitor-fixes.md). Other tools can add steps the same way
  (`public/fixes.js`).

## [0.61.2.0] - 2026-10-31

### Added

- Azure Monitor: the page opens with a row of coverage counts: virtual machines, Arc servers and scale sets
  monitored out of all, with what is missing; alert rules on out of all; data collection rules, action groups and
  workspaces.

### Changed

- Resource Graph queries use API version 2024-04-01 (was 2021-03-01); the request and answer are the same.
- The Azure Monitor scan runs one extra Resource Graph query to see which scale sets have the Azure Monitor Agent.

### Fixed

- Access review lists apps (service principals) in groups. Group members are read from Graph beta, since v1.0
  leaves service principals out; v1.0 is the fallback if beta fails. Access lookup's group view lists them too.

## [0.61.1.0] - 2026-10-31

### Changed

- Azure Monitor reads machine heartbeats through the Logs Query API v1 (`api.loganalytics.azure.com`) instead of
  the retired ARM route, using each workspace's ID from Resource Graph.
- Azure and Graph requests are also retried on 500 and 502 (Graph: a POST still only on 429, 503 and 504), with a
  random wait between tries. Retry-After is read as seconds or as a date, and a long wait asked for by Azure (for
  example by Cost Management on a first cost backfill) is honoured, up to 15 minutes per request.
- Every Azure and Graph request sends its own request id (`x-ms-client-request-id`, Graph `client-request-id`); an
  error names it and Microsoft's request id, for a support case.
- Resource Graph queries ask for rows as objects explicitly (`resultFormat: objectArray`, already the default).
- Stale accounts reads users 500 at a time (the most Graph allows with sign-in activity).
- Audit log lines of a single sign-on user also hold the Entra object ID and tenant ID, so they still match after a
  UPN change. The UPN is still what is shown.

### Fixed

- PIM: when Graph refuses the PIM for Groups activation history, the scan says so once (log and page note) instead
  of showing every group activation as never used.
- Key Vault: the permissions shown for the scan now list the Graph permissions it uses to look up who has access
  (`User.Read.All`, `GroupMember.Read.All`, `Application.Read.All`).

## [0.61.0.0] - 2026-10-31

### Added

- Connectivity health scan (hourly): VPN connections and ExpressRoute circuits that are down, failed gateways,
  private endpoints waiting for approval or without a DNS zone group, and unhealthy backends on application gateways,
  load balancers and Front Door.
- Enterprise apps scan (daily): SAML signing certificates and service principal secrets that expire, single sign-on
  apps anyone may sign in to, apps with no owner, unused apps from other tenants and disabled apps that still hold
  Azure roles.
- Azure Virtual Desktop scan (daily): unavailable or broken session hosts, empty host pools, pooled pools without a
  scaling plan, unassigned personal desktops, Start VM on Connect off, application groups in no workspace and empty
  workspaces. A Host pools tab lists every pool.
- Domains and mail scan, off by default (`DOMAIN_CHECKS=on`, or `dns` for DNS only): expiring or unlocked domain registrations,
  App Service Domains without auto-renew, Azure DNS zones that are not delegated, and SPF, DMARC and DKIM gaps. It
  looks up registrations at rdap.org. The header of `src/tools/domains.js` lists how to remove it.
- `GET /health` (no sign-in): 503 when no scheduled scan has finished for `HEALTH_SCAN_MAX_AGE_HOURS` (26). Module
  v1.10.0 uses it as the App Service health check.
- A per-tenant scan deadline (`SCAN_DEADLINE_MINUTES`, 45).
- The tests run in CI before the image is built.

### Changed

- Azure and Graph requests time out after `AZURE_REQUEST_TIMEOUT_SECONDS` (60) and are retried (Graph only for
  reads).

### Fixed

- Blob reads and writes of the findings store are retried on short outages.
- A scan that hangs no longer leaves the tenant on "already running".
- follow-redirects 1.16.2 (CVE-2026-116689, information disclosure through cross-origin redirects).

## [0.60.0.4] - 2026-10-30

### Changed

- Documentation: with `private_network` the storage account and key vault now let in the web app's subnet through
  service endpoints by default (module v1.9.0, no extra cost); private endpoints are opt-in. The setup LLD,
  architecture and data pages and the network diagram show this.

## [0.60.0.3] - 2026-10-30

### Changed

- Documentation: the setup LLD describes the Terraform module's new `public_network_access` switch (module v1.8.0),
  which turns public network access off on the storage account, key vault and web app where they have private
  endpoints.

## [0.60.0.2] - 2026-10-30

### Changed

- Documentation: with the Terraform module's `app_private_endpoint` (module v1.7.0) the web app keeps public network
  access on behind access restrictions that deny every network, so deployments are not blocked; allowed IPs and
  subnets work with it, and `continuous_deployment` keeps the Kudu site open for the deploy webhook. The setup LLD,
  the architecture page, SECURITY.md and the network picture say so.

## [0.60.0.1] - 2026-10-30

### Changed

- Documentation: with the Terraform module's private endpoints (module v1.6.1) the storage account and the key vault
  keep public network access on, restricted by their firewalls (deny every network, trusted Azure services allowed),
  instead of turning it off. The setup LLD, the architecture and data pages and the network picture say so.

## [0.60.0.0] - 2026-10-30

### Added

- Vulnerabilities (CVEs): a new scan that lists the known vulnerabilities Defender for Cloud found on machines and
  container images, one row per CVE and subscription with the resources it is on, the severity, CVSS score and
  whether a fix is available. CVEs on CISA's Known Exploited Vulnerabilities list are critical, then CVEs whose EPSS
  score says they are likely to be exploited soon, then critical CVEs. Subscriptions with machines or registries
  that Defender does not scan are flagged. Reader is enough; the data needs Defender for Servers, Defender CSPM or
  Defender for Containers.
- Settings `CVE_MIN_SEVERITY` (blank = critical), `CVE_EPSS_MIN` (blank = 0.1) and `CVE_FEEDS` (blank = on). The CISA
  list and EPSS scores are fetched once a day from `www.cisa.gov` and `api.first.org` (only CVE ids are sent) and kept
  in `DATA_DIR/cve-feeds.json`.

## [0.59.0.1] - 2026-10-30

### Changed

- Documentation: the setup LLD, the architecture page, SECURITY.md and the network picture describe the Terraform
  module's new `app_private_endpoint` option (module v1.6.0: the web app reached only through a private endpoint),
  how it differs from `allowed_subnet_ids`, and subnet sizes.

## [0.59.0.0] - 2026-10-30

### Added

- Architecture: lines from a managed identity to what its Azure roles reach (a resource, a part of one such as a blob
  container, or a resource group) and to Key Vaults whose access policies let it in. A solid line when the role reads
  or writes data, dashed when it manages the resource. A user-assigned identity that is not drawn hands its lines to
  the resources that use it. Roles on a whole subscription or management group are left out.
- Architecture: a Microsoft Entra ID box with the app registrations that sign people in to a drawn web app (found by
  a redirect URI on the web app's host name, which covers both the dashboard's own SSO and App Service
  authentication). Needs `Application.Read.All` on the scan identity.
- "Identity access" and "Sign-in" switches, legend entries, details panel rows (identity, what it may reach, which
  identities have access, sign-in) and the same lines in the draw.io download.
- The drawing says which tenants the last scan could not read these for. Both appear after the next Architecture
  scan.

### Changed

- Architecture: a line between two tiles in one row, with tiles between them, goes over the row instead of through
  the tiles.

## [0.58.1.1] - 2026-10-30

### Added

- A note in the README and `docs/diagrams/README.md`: the Azure icons are Microsoft's, used under its terms for
  architecture diagrams, and not covered by this repo's license.

## [0.58.1.0] - 2026-10-29

### Changed

- The architecture pictures in the high-level design, the setup low-level design and the architecture page use the
  official Azure icons. They are made from Python with the `diagrams` library (`docs/diagrams/*.py`, rendered in a
  pinned Docker image); sequences and flows stay Mermaid. `npm run diagrams` makes both kinds.
- The build and release picture names the repo `Gooseankles/cirrus-watch`.

## [0.58.0.0] - 2026-10-29

### Added

- Remove a customer tenant: a Remove button in Settings → Customer tenants deletes everything the dashboard holds
  for it, with nothing kept: its client secret and notification link (deleted and purged from the key vault), its
  storage container with results, history, accepted findings and cost history, its own settings and its activity-log
  lines. The dialog lists what goes and asks for the tenant's key typed back. Global Admin only; the audit log keeps
  who removed what. If a step fails the rest still run and the page says what to finish by hand.

### Changed

- A tenant that comes from Terraform can be removed in Settings too. The dashboard then ignores it (no scans, no
  container made again, not shown) and lists it as "Removed, waiting for Terraform" with Undo, until its key is
  removed from `customers` in Terraform and applied, which deletes its roles and groups.
- The repo is now `Gooseankles/cirrus-watch` (the old address redirects); links point there. The Docker image
  keeps its name, `trozity/azure-ops-dashboard`.

### Fixed

- Dependabot updates merge by themselves again: the workflow checked for the repo's old name.
- The Customer tenants note no longer says User-<key> is read only; both customer roles see and run its scans.

## [0.57.3.1] - 2026-10-29

### Added

- The high-level and setup low-level designs describe running it for one tenant only: what is made and what is
  left out, two pictures, and how to add customer tenants later.

## [0.57.3.0] - 2026-10-29

### Added

- Pictures in the high-level and setup low-level designs: building blocks, from scan to report, tenants, who sees
  what, the Azure resources, the path of a request, where the data lives, adding a customer tenant, the private
  network, how an update arrives and where it can go wrong.
- The setup low-level design covers more: the role assignments Terraform makes, session storage, the local admin
  lockout, Run now, history pruning, how image tags are made, and more failure cases.
- `npm run diagrams` makes the pictures from their Mermaid text (`docs/diagrams/*.mmd`); the Docs check fails
  when a picture is missing or older than its text.

### Fixed

- The diagrams in the docs show on GitHub's phone app and in editors without Mermaid: they are now PNG images.
- Three diagrams that GitHub could not draw (a reserved word and semicolons in their text) draw again.
- The designs and `.env.example` no longer say that only Admins may press Run now, and the high-level design
  no longer says every scan runs daily or weekly (resource health runs hourly).

## [0.57.2.0] - 2026-10-29

### Added

- Each scan page links to what that scan checks in `docs/tools.md`.
- Documentation by reader in `docs/`: guides (using the dashboard, sign-in and roles, customer tenants,
  notifications), operations (upgrade, roll back, back up, rotate secrets), troubleshooting, where data is kept, a
  high-level design, a setup low-level design and eight decision records. `CONTRIBUTING.md` says how to run it
  locally, add a tool and what a change brings with it.

### Changed

- The README is now a short front door: tools, quick start and a map of the docs.

## [0.57.1.2] - 2026-10-29

### Fixed

- The docs generator escapes backslashes as well as pipes in the README tools table (CodeQL); Markdown table
  spacing (MD060) is no longer checked.

## [0.57.1.0] - 2026-10-29

### Added

- `docs/tools.md` with everything each scan checks; the README keeps one line per tool.
- `npm run docs`: writes the README tools table, the Node.js version, the tool count in `docs/architecture.md` and
  the tool ids in `.env.example` from the code, and checks that each tool is registered everywhere it must be.
- Docs workflow: the generated parts must match the code, Markdown style (markdownlint) and links (lychee).
- This changelog, and a pull request template with a docs checklist.

### Fixed

- Opening the IPAM and Server load pages is recorded in the audit log again (they were refused as unknown pages).
- Docs: the Cost anomalies text now says what the scan does (each resource group's cost yesterday against the day
  before, 50 % by default); Node.js 26; `.env.example` lists every tool id and the `federated` sign-in type;
  module and image versions in the README example; history retention default (365, the module sets 730);
  SECURITY.md names the audit log.

### Changed

- `package.json` no longer carries a version of its own; `VERSION` is the only one.

## [0.57.0.0] - 2026-10-29

### Changed

- Whoever may see a scan may run it. The `<Area>.Run` roles are gone; old ones count as `<Area>.Read`. See
  [Upgrading](#upgrading).

## [0.56.0.0] - 2026-10-29

### Added

- Certificates scan: TLS certificates of App Service custom domains and of websites listed in Settings: expired,
  expiring, wrong name, untrusted chain and sites that do not answer.

## [0.55.1.0] - 2026-10-29

### Security

- The history storage address must be an Azure blob endpoint, since the app sends its storage token there.
- Regular expressions that could run slowly on crafted input were rewritten; a log line no longer carries raw input.
- Third-party GitHub Actions are pinned by commit.

## [0.55.0.0] - 2026-10-29

### Added

- Compliance mapping for the NIS2 Implementing Regulation (EU) 2024/2690.
- CodeQL scanning, a weekly image rebuild and automatic merging of Dependabot patch updates.

### Security

- Requests that change something are refused unless they come from the dashboard's own origin.
- A warning when the local admin password is short.

## [0.54.0.0] - 2026-10-29

### Added

- End-of-support dates come live from endoflife.date (refreshed daily).
- CIS Controls v8.1 and mapping review dates on the Compliance page.

## [0.53.4.0] - 2026-10-28

### Changed

- Node.js 26 LTS image; newer Trivy, msal-node, axios and dotenv.
- A session key is generated when `SESSION_SECRET` is not set. SECURITY.md added.

## [0.53.3.1] - 2026-10-28

### Changed

- Licence: AGPL-3.0-only.

## [0.53.1.0] - 2026-10-28

### Changed

- The app is now called Cirrus Watch.

## [0.53.0.0] - 2026-10-28

### Added

- Area roles: Identity, Platform, Security and Cost, for every tenant or one. Readers can accept findings.
- The Key Vault item check is optional and off by default.

## [0.52.0.0] - 2026-10-28

### Added

- IPAM page: free addresses per subnet, an address map with owners, IP search and a free range finder.

## [0.51.0.0] - 2026-10-27

### Added

- Notifications by email through Microsoft Graph, for organisations that block Teams webhooks (0.51.1.0 sends
  through Exchange RBAC for Applications).

## [0.50.0.0] - 2026-10-27

### Added

- Scans can be turned off per tenant (Settings, Scans).

### Fixed

- 0.50.1.0 to 0.50.6.0: the updates scan, resource health, Defender recommendations and patch schedules no longer
  fail on Resource Graph; the access lookup is faster.

## [0.49.0.0] - 2026-10-27

### Added

- Five new scans: updates and patching, Entra tenant settings, resource health, subscriptions and network hygiene.

## [0.48.0.0] - 2026-10-27

### Added

- NSG flow log checks, emergency access accounts and more checks in existing scans.

## [0.47.0.0] - 2026-10-27

### Added

- Firewall reach map with downloads (CSV, PNG, SVG) and its own VM picker.

[0.57.2.0]: https://github.com/Gooseankles/azure-ops-dashboard/compare/6c6c398...main
[0.57.1.2]: https://github.com/Gooseankles/azure-ops-dashboard/compare/5ccfbc6...6c6c398
[0.57.1.0]: https://github.com/Gooseankles/azure-ops-dashboard/compare/c5ac2f4...5ccfbc6
[0.57.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/c5ac2f4
[0.56.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/17e93d6
[0.55.1.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/f01e25a
[0.55.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/7dcdb51
[0.54.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/955ee54
[0.53.4.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/e2731b9
[0.53.3.1]: https://github.com/Gooseankles/azure-ops-dashboard/commit/38821dd
[0.53.1.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/d71ae3e
[0.53.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/a5004d8
[0.52.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/8a6124f
[0.51.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/83e885a
[0.50.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/e9420f2
[0.49.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/744c9de
[0.48.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/e20adda
[0.47.0.0]: https://github.com/Gooseankles/azure-ops-dashboard/commit/ee29a9c
