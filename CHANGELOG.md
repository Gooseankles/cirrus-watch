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

[0.57.1.2]: https://github.com/Gooseankles/azure-ops-dashboard/compare/5ccfbc6...main
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
