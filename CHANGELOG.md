# Changelog

What changed in each version of Cirrus Watch, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are `major.minor.patch.build` (the `VERSION` file);
each one is also a Docker image tag (`trozity/azure-ops-dashboard:<version>`). The infrastructure has its own
changelog in the [Terraform module](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard/blob/main/CHANGELOG.md).

Versions before 0.47 are only in the git history.

## Upgrading

Steps needed when moving past a version. Read this before you change the image tag or the module version.

- **0.57.0.0: no more `<Area>.Run` roles.** Whoever may see a scan may run it. Old `<Area>.Run` and
  `<Area>.Run-<key>` roles still work and count as `<Area>.Read`, so nobody loses access, but their names now say
  more than they give. With Terraform, module v1.5.0 or newer drops the `.Run` app roles and groups and puts
  `run_members` into the matching `.Read` group; `run_members` is deprecated and will be removed in a later major
  version, so move those people to `read_members`.
- **0.55.0.0: requests that change something must come from the dashboard's own pages.** A script that posts to
  the API with an `Origin` header must use the dashboard's own address there; without the header it still works.
- **0.53.4.0: the image is built on Node.js 26.** Running from source needs Node.js 22 or newer; 26 is what is
  tested.

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
