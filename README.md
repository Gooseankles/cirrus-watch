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
| [Enterprise apps](docs/tools.md#enterprise-apps) | Daily | Enterprise apps with SAML certificates or service principal secrets that expire, open sign-in, no owner or no use. |
| [Licence coverage](docs/tools.md#licence-coverage) | Daily | Entra ID licences needed for the features in use, against those you own. |
| [Defender for Cloud](docs/tools.md#defender-for-cloud) | Daily | Low secure scores, unhealthy recommendations and Defender plans that are off. |
| [Vulnerabilities (CVEs)](docs/tools.md#vulnerabilities-cves) | Daily | Known vulnerabilities on machines and container images from Defender for Cloud, ranked by real-world exploitation. |
| [Safety nets](docs/tools.md#safety-nets) | Daily | Subscriptions with no working budget and key resources with no delete lock. |
| [Azure Monitor](docs/tools.md#azure-monitor) | Daily | Machines, alert rules, action groups and workspaces that Azure Monitor does not cover or that do not work. |
| [Updates and patching](docs/tools.md#updates-and-patching) | Daily | Machines with pending Critical or Security updates, missing assessments or failed installations. |
| [Entra tenant settings](docs/tools.md#entra-tenant-settings) | Daily | Tenant settings that let any user register apps, invite guests or create tenants. |
| [Resource health](docs/tools.md#resource-health) | Hourly | Resources that are down or degraded now, Azure outages and planned maintenance. |
| [Subscriptions](docs/tools.md#subscriptions) | Daily | Subscriptions in the Tenant Root Group, with no Owner, or not in good standing. |
| [Network hygiene](docs/tools.md#network-hygiene) | Daily | WAFs that block nothing, dangling DNS records and routes to nowhere. |
| [Connectivity health](docs/tools.md#connectivity-health) | Hourly | VPN connections and ExpressRoute circuits that are down, failed gateways, stuck private endpoints and unhealthy backends. |
| [Azure Virtual Desktop](docs/tools.md#azure-virtual-desktop) | Daily | Session hosts that are down or forgotten, host pools that cost more than needed, and app groups users cannot see. |
| [Cost history](docs/tools.md#cost-history) | Daily | Daily cost per subscription and monthly cost by service and resource group. |
| [Access lookup](docs/tools.md#access-lookup) | On demand | Every Azure and Entra role a person or group holds or can activate, with the group chain. |
<!-- tools:end -->

Every run is kept, so each scan shows a trend and what is new or fixed. Findings that are known and fine can be
accepted; a monthly report, weekly trends and NIS2, NSM and CIS compliance pages are built from the results. See
[using the dashboard](docs/guides/using-the-dashboard.md).

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
  source = "github.com/Gooseankles/terraform-azurerm-ops-dashboard?ref=v1.5.2"

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

## Documentation

Everything is listed by reader in **[docs/](docs/README.md)**. The most used pages:

| You want to | Read |
| --- | --- |
| Understand what it is and how it fits together | [High-level design](docs/hld.md), [architecture](docs/architecture.md) |
| See what the Terraform setup creates and how it runs | [Setup low-level design](docs/lld-setup.md) |
| Use the scans, reports and compliance pages | [Using the dashboard](docs/guides/using-the-dashboard.md), [tools](docs/tools.md) |
| Give people access | [Sign-in and roles](docs/guides/sign-in-and-roles.md) |
| Run it for your own tenant only, or for several | [Single tenant or several](docs/hld.md#single-tenant-or-several) |
| Scan other organizations' tenants | [Customer tenants](docs/guides/customer-tenants.md) |
| Get daily messages | [Notifications](docs/guides/notifications.md) |
| Upgrade, back up, rotate secrets | [Operations](docs/operations.md), [changelog](CHANGELOG.md) |
| Fix a problem | [Troubleshooting](docs/troubleshooting.md) |
| Know why it is built this way | [Decision records](docs/adr/README.md) |
| Change the code or add a tool | [Contributing](CONTRIBUTING.md) |

## Permissions

The scans only read. The scan identity (by default the web app's managed identity) needs **Reader** on the
subscriptions, **Cost Management Reader** for the cost scans and read-only **Microsoft Graph application
permissions**. Every identity and exactly what it needs: [docs/permissions.md](docs/permissions.md). Where results,
settings and secrets are stored: [docs/data.md](docs/data.md).

## Security

How to report a security problem and how to run Cirrus Watch safely: [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Gooseankles.

Cirrus Watch is free software under the [GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0-only).
You may use, change and share it; if you change it and let others use your version, also over a network, you must
offer them its source code under the same license. It comes with no warranty.

The Azure icons in the pictures under [docs/diagrams](docs/diagrams/) are Microsoft's, used under
[Microsoft's terms for architecture diagrams and documentation](https://learn.microsoft.com/en-us/azure/architecture/icons/).
They are not covered by this repo's license.
