# High-level design

What Cirrus Watch is for, what it is made of, and the main choices behind it, on one page. The details are in
[architecture.md](architecture.md) (every part, with diagrams), the [setup low-level design](lld-setup.md) (what
the deployment creates and how a start-up, a sign-in and a scan run step by step) and the
[decision records](adr/README.md).

## Purpose

Teams that run Azure tenants repeat the same checks: what costs money for nothing, who has access to what, which
secrets expire, which resources break policy or are open to the internet. Cirrus Watch runs those checks on a
schedule, keeps every result so changes over time show, and puts them on one page per check, for one tenant or for
several customers' tenants.

## Who uses it

| Who | What they do |
| --- | --- |
| Admin (`Admin` role) | Sets it up, changes Settings, adds customer tenants, sees everything |
| Team member (`User`, `<Area>.Read`, `…-<key>` roles) | Reads the scans of their area or customer, runs them, accepts known findings |
| Customer contact | Receives the monthly report (Print / PDF) and the daily notifications |
| Whoever deploys it | Runs the Terraform module, or runs the container elsewhere |

## Scope

**In scope:** read-only checks of Azure Resource Manager, Cost Management and Microsoft Graph data; history and
trends; accepting findings; monthly report and compliance view (NIS2, NSM, CIS); daily notifications; several
tenants from one installation.

**Not in scope:** changing anything in a scanned tenant (the scans only read, see
[ADR 0001](adr/0001-scans-only-read.md)); real-time alerting (scans run daily or weekly); being a SIEM or replacing
Microsoft Defender for Cloud; proving compliance (a missing finding does not prove a control is met).

## Context

```mermaid
flowchart LR
  people["People<br/>(browser)"] -- "HTTPS, Entra sign-in" --> cw["Cirrus Watch<br/>(one container)"]
  cw -- "read" --> arm["Azure Resource Manager<br/>Resource Graph, Cost Management"]
  cw -- "read" --> graph["Microsoft Graph<br/>(Entra ID)"]
  cw -- "read" --> cust["Customer tenants<br/>(ARM + Graph, their own app)"]
  cw -- "daily message" --> chan["Teams, Slack, webhook<br/>or email (Graph)"]
  cw -- "results and history" --> st["Azure Storage<br/>(or local disk)"]
  cw -- "secrets from Settings" --> kv["Azure Key Vault<br/>(or local file)"]
  cw -- "end-of-support dates" --> eol["endoflife.date"]
  entra["Entra ID"] -- "ID token with roles" --> cw
```

## Building blocks

| Block | What it does | Where in the code |
| --- | --- | --- |
| Web server | Serves the pages and the JSON API; security headers, origin check | `server.js` |
| Sign-in and access | Entra SSO or local admin; roles to tenants and areas | `src/auth.js`, `src/access.js` |
| Scan tools | One module per check; each returns findings | `src/tools/*.js` ([tools.md](tools.md)) |
| Tool registry and scheduler | Runs each tool per tenant on its cron schedule or on Run now; keeps runs apart | `src/toolRegistry.js` |
| Credentials | Picks the identity per tool and tenant (managed identity, federated, secret) | `src/credentials.js` |
| Findings store | Latest results, history snapshots and counts, per tenant container | `src/findingsStore.js` |
| Secret store | Secrets in Key Vault, with a file fallback | `src/secretStore.js` |
| Reports | Monthly report, weekly trends, compliance view | `src/report.js`, `src/trends.js`, `public/compliance.js` |
| Notifications | Daily digest per tenant, retry queue | `src/notify.js` |
| Self-monitoring | Server load sampling and alarms, audit log, activity log | `src/monitor.js`, `src/audit.js`, `src/log.js` |
| Front end | No-build single page app | `public/` |

## Main design choices

| Choice | Why | Record |
| --- | --- | --- |
| Scans only read | Safe to point at production and at customers; small permissions | [0001](adr/0001-scans-only-read.md) |
| Managed identity first, no secrets for the home tenant | Nothing to leak or rotate | [0002](adr/0002-managed-identity-first.md) |
| Secrets typed in Settings go to Key Vault, never into Terraform | Terraform state stays free of customer secrets | [0003](adr/0003-secrets-in-key-vault-not-terraform.md) |
| Access by area and by tenant, roles held in Entra | Each team sees its own scans; access is managed with Entra groups | [0004](adr/0004-access-areas.md) |
| Each customer tenant has its own app registration | Entra does not let an app trust another tenant's managed identity | [0005](adr/0005-customer-tenants-own-app-registration.md) |
| One process, one instance, files and blobs instead of a database | Few moving parts, cheap to run (a B1 plan is enough) | [0006](adr/0006-one-process-one-instance.md) |
| Four-part app version, semver for the module | One number per image; the module needs semver for `?ref=` pins | [0007](adr/0007-versioning.md) |
| AGPL-3.0 | Changes offered as a service stay open | [0008](adr/0008-agpl-licence.md) |

## Deployment options

| Option | What you get |
| --- | --- |
| Terraform module on App Service (recommended) | Everything in [lld-setup.md](lld-setup.md): managed identities, secretless SSO, storage, Key Vault, optional private network and alerts |
| Docker anywhere | The image with a volume for `DATA_DIR`; an Azure identity by secret, managed identity or federated credential in `.env` |
| From source | `npm start` with Node.js 22 or newer; for development |

## Quality attributes

- **Security:** read-only scan roles, managed identities, PKCE sign-in, roles from Entra, origin check on changing
  requests, strict content security policy, secrets never returned by the API, audit log. See
  [SECURITY.md](../SECURITY.md) and [architecture section 11](architecture.md#11-security-controls-in-short).
- **Reliability:** a tenant that fails keeps its last results and does not stop the others; the app starts even
  when the vault is down and retries it every minute; failed notifications are retried every hour; Azure Monitor
  emails when CPU, memory or server errors stay high (`alert_emails`).
- **Data separation:** each customer tenant has its own storage container and its own roles; a person sees only
  the tenants and areas their roles reach.
- **Cost:** one small App Service plan, one storage account, one key vault; no database.
- **Limits:** one instance (scale up, not out); a scan goes through its tenants one after another; large
  tenants make long scans (the Server load page shows which).

## Risks and open points

- The compliance mapping is written by hand; a review date is kept in `.github/frameworks.json` and the weekly
  stack report flags new framework versions.
- Graph permissions granted to a managed identity reach its token only after up to 24 hours.
- A customer's client secret expires; their scans fail until a new one is pasted in Settings.
