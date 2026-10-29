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
