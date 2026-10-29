# Architecture

How the dashboard is built and deployed: first the big picture (high-level design), then the parts inside it
(low-level design). The diagrams are Mermaid, drawn by GitHub. Names in `code` are settings, Terraform inputs or
files in this repo. Permissions per identity are listed in [permissions.md](permissions.md); every Terraform input
in the [Terraform module's README](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard#readme).

- [1. Overview](#1-overview)
- [2. Azure resources (Terraform)](#2-azure-resources-terraform)
- [3. Identities: who talks to what](#3-identities-who-talks-to-what)
- [4. Signing in](#4-signing-in)
- [5. A scan run](#5-a-scan-run)
- [6. Customer tenants](#6-customer-tenants)
- [7. Network](#7-network)
- [8. Build and release](#8-build-and-release)
- [9. Inside the app (low-level design)](#9-inside-the-app-low-level-design)
- [10. Where data is kept](#10-where-data-is-kept)
- [11. Security controls in short](#11-security-controls-in-short)

## 1. Overview

One container on Azure App Service. People sign in with Entra ID; scheduled scans read Azure (ARM) and Entra
(Microsoft Graph) with the web app's managed identity, and store the results in a storage account. Nothing in Azure is
changed by the scans: every permission they use is a read permission.

```mermaid
flowchart TB
  people["People<br/>browser"]
  hub["Docker Hub<br/>trozity/azure-ops-dashboard"]
  subgraph home["Home tenant"]
    subgraph rg["Resource group rg-&lt;name&gt;"]
      app["App Service<br/>Linux container<br/>Node.js + Express"]
      st[("Storage account<br/>scan results, history,<br/>cost history")]
      kv[("Key vault<br/>secrets typed in Settings")]
    end
    subgraph apis["Microsoft cloud APIs"]
      entra["Entra ID<br/>sign-in app + app roles"]
      arm["Azure Resource Manager<br/>subscriptions"]
      msgraph["Microsoft Graph<br/>users, roles, policies"]
    end
  end
  cust["Customer tenants<br/>ARM + Graph"]

  people -- "HTTPS" --> app
  hub -- "image pull" --> app
  app -- "Entra token" --> st
  app -- "Entra token" --> kv
  app -- "sign-in: ID token<br/>with roles claim" --> entra
  app -- "scans: read only" --> arm
  app -- "scans: read only" --> msgraph
  app -- "scans: as each<br/>customer's app" --> cust
```

| Part | What it is | Why |
|---|---|---|
| App Service (Linux) | One container, `always_on`, HTTPS only, TLS 1.2+ | Small, cheap, no servers to patch; the scheduler lives in the app |
| Container image | `node:26-alpine` (pinned by digest) without npm, runs as user `node`, port 7070 | Built by GitHub Actions on every push to `main`; pushed only if the Trivy scan finds no fixable critical or high problem |
| Storage account | Blob containers `dashboard` and `dashboard-<customer>` | Scan results and history survive restarts and redeploys; no account keys |
| Key vault | RBAC, soft delete, secrets named `dashboard-…` | Client secrets entered in Settings never sit on the app's disk |
| Sign-in app registration | Entra app with app roles, assignment required | Who may sign in and what they may do |
| Managed identities | System-assigned (scans, storage, vault) and user-assigned (SSO) | No secret exists for the home tenant |

## 2. Azure resources (Terraform)

The module lives in its own repo, [terraform-azurerm-ops-dashboard](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard) (the module at its root,
a root configuration in `examples/default`). Dashed boxes are optional
(`create_history_storage`, `create_secret_vault`, `create_sso_app`, `create_role_groups`, `private_network`).

```mermaid
flowchart TB
  subgraph az["Azure subscription"]
    subgraph rg["rg-&lt;name&gt;"]
      asp["App Service plan<br/>asp-&lt;name&gt; (sku_name)"]
      web["Linux web app &lt;name&gt;<br/>identity: SystemAssigned + UserAssigned"]
      uami["User-assigned identity<br/>id-&lt;name&gt;-sso"]
      st["Storage account st&lt;name&gt;&lt;suffix&gt;<br/>shared keys off, TLS 1.2"]
      cont["Containers: dashboard,<br/>dashboard-&lt;key&gt; per customer"]
      kv["Key vault kv&lt;name&gt;&lt;suffix&gt;<br/>RBAC, purge protection optional"]
      vnet["VNet + subnets,<br/>private endpoints, private DNS"]
    end
    scopes["Scan scopes<br/>management groups / subscriptions"]
  end
  subgraph entra["Entra ID (home tenant)"]
    sso["App registration<br/>Cirrus Watch (&lt;name&gt;)<br/>app roles Admin, User, Admin-&lt;key&gt;, User-&lt;key&gt;,<br/>&lt;Area&gt;.Read/Run(-&lt;key&gt;)"]
    fic["Federated credential<br/>trusts id-&lt;name&gt;-sso"]
    groups["Security groups<br/>one per app role"]
    graphperm["Graph app role assignments<br/>to the web app's identity"]
  end

  asp --> web
  uami --> web
  st --> cont
  web -- "Storage Blob Data Contributor" --> st
  web -- "Key Vault Secrets Officer" --> kv
  web -- "Reader, Cost Management Reader,<br/>Key Vault Reader" --> scopes
  sso --> fic
  fic -. "subject = principal of" .-> uami
  groups -- "assigned to app roles" --> sso
  graphperm -. "granted to" .-> web
  vnet -.-> web

  classDef opt stroke-dasharray: 5 5
  class st,cont,kv,vnet,groups opt
```

The image itself is not built by Terraform: the web app points at `image` (for example
`trozity/azure-ops-dashboard:0.18.0.0`) on Docker Hub and App Service pulls it.

App settings Terraform writes into the web app (the app reads them as environment variables):

| Setting | From |
|---|---|
| `AZURE_AUTH_TYPE=managed-identity` | Scans use the system-assigned identity |
| `DASHBOARD_AZURE_TENANT_ID`, `DASHBOARD_AZURE_CLIENT_ID`, `DASHBOARD_REDIRECT_URI` | Sign-in app |
| `DASHBOARD_FEDERATED_MI_CLIENT_ID` (or `DASHBOARD_AZURE_CLIENT_SECRET`) | Secretless SSO through the user-assigned identity |
| `STORAGE_ACCOUNT_URL`, `STORAGE_CONTAINER`, `HISTORY_RETENTION_DAYS` | History storage |
| `SECRET_VAULT_URL` | Secret vault |
| `DASHBOARD_TENANTS` | `customers` as JSON (no secrets) |
| `SESSION_SECRET` | `random_password`, kept in Terraform state |
| `DATA_DIR=/home/data`, `WEBSITES_PORT=7070` | App Service persistent storage and port |

## 3. Identities: who talks to what

Four kinds of identity. Only the customer apps use a secret, and that secret lives in the key vault.

```mermaid
flowchart LR
  subgraph webapp["Web app"]
    sys["System-assigned identity<br/>(the shared SPN)"]
    usr["User-assigned identity<br/>id-&lt;name&gt;-sso"]
  end
  ssoapp["Sign-in app registration"]
  tool["Per-tool SPN (optional)<br/>Settings → SPN override"]
  custapp["Customer app registration<br/>(one per customer tenant)"]

  arm["ARM: Reader, Cost Management Reader,<br/>Key Vault Reader"]
  gperm["Graph application permissions<br/>(read-only)"]
  st["History storage"]
  kv["Secret vault"]
  login["Entra sign-in<br/>(auth code + PKCE)"]
  carm["Customer ARM + Graph"]

  sys --> arm
  sys --> gperm
  sys --> st
  sys --> kv
  usr -- "token for api://AzureADTokenExchange" --> ssoapp
  ssoapp -- "client assertion, no secret" --> login
  tool -. "instead of the shared SPN<br/>for that tool" .-> arm
  custapp -- "client secret from the vault" --> carm
```

- **Shared SPN** = the web app's system-assigned identity. All home-tenant scans use it unless a tool has its own
  SPN override (`<TOOL_ID>_AZURE_CLIENT_ID`). History storage can have its own override too (`history-storage`).
- **SSO**: the sign-in app has a federated credential that trusts the user-assigned identity, so MSAL signs its token
  request with that identity's token instead of a client secret.
- **Customer tenants**: Entra does not let an app trust a managed identity of another tenant, so each customer has
  its own app registration with a client secret, entered only in Settings and kept in the key vault.

## 4. Signing in

```mermaid
sequenceDiagram
  autonumber
  actor P as Person
  participant A as Dashboard (Express)
  participant MI as Managed identity endpoint
  participant E as Entra ID
  P->>A: GET /auth/login
  A->>A: state + PKCE verifier into the session
  A-->>P: redirect to Entra (openid, profile)
  P->>E: sign in (MFA, Conditional Access apply here)
  E-->>P: redirect to /auth/callback?code&state
  P->>A: GET /auth/callback
  A->>A: check state (timing-safe)
  A->>MI: token for api://AzureADTokenExchange (user-assigned identity)
  MI-->>A: assertion
  A->>E: code + PKCE verifier + client assertion
  E-->>A: ID token with roles claim
  alt no dashboard role
    A-->>P: /login.html?error=no-role (audit: sign-in-refused)
  else Admin, User, Admin-key or User-key
    A->>A: new session (8 h, httpOnly, Secure, SameSite=Lax)
    A-->>P: redirect to / (audit: sign-in)
  end
```

The break-glass local account (`admin` + `DASHBOARD_ADMIN_PASSWORD`) skips Entra and always has the Admin role; ten
wrong passwords from one address lock that address for 15 minutes.

What each role may do (`src/access.js`):

| Role | Tenants it sees | Areas | Settings, audit log |
|---|---|---|---|
| `Admin` | all | all | yes |
| `User` | all | all | no |
| `Admin-<key>` | that customer | all | no |
| `User-<key>` | that customer | all | no |
| `<Area>.Read` | all | that area | no |
| `<Area>.Read-<key>` | that customer | that area | no |

Areas are Identity, Platform, Security and Cost (`TOOL_AREAS` in `access.js`; a scan can be in several). Anyone who
may see a scan in a tenant may run it (Run now) and accept or snooze its findings there. `<Area>.Run` roles from
older versions count as `<Area>.Read`.

## 5. A scan run

Each scan tool has a cron schedule (for example MFA coverage daily at 05:50) and an Admin can press **Run now**. One
run covers the home tenant and every enabled customer tenant, one after another.

```mermaid
sequenceDiagram
  autonumber
  participant C as node-cron / Run now
  participant R as toolRegistry.execute
  participant T as Tool run()
  participant ID as credentials.getCredential
  participant AZ as ARM / Graph
  participant S as findingsStore
  participant L as Activity log
  C->>R: start (all tenants, or the runner's tenants)
  loop each tenant
    R->>R: tenantContext.runIn(tenant)
    R->>T: run()
    T->>ID: credential for this tool in this tenant
    ID-->>T: managed identity, tool SPN or customer app
    T->>AZ: read-only calls (paged)
    AZ-->>T: resources, users, policies
    T-->>R: findings [{kind, id, name, detail, ...}]
    R->>AZ: subscription names
  end
  R->>S: write(tool, findings, tenants done, errors)
  S->>S: per tenant: diff with last run (new / resolved), keep firstSeen
  S->>S: put history/<tool>/<ranAt>.json, findings/<tool>.json, index.json
  S->>S: drop runs older than HISTORY_RETENTION_DAYS
  R->>L: "scan complete: n findings, x new, y resolved"
```

A tenant that fails keeps its last results, with the error noted on them; the other tenants still save. A tenant
whose scan failed shows as "partly checked" on the Compliance page.

On read (`GET /api/tools/<id>/findings`) the app merges the tenants the person may see, adds subscription and tenant
names, and marks accepted or snoozed findings. Compliance tags are added in the browser (`public/compliance.js`).

## 6. Customer tenants

```mermaid
flowchart LR
  subgraph home["Home tenant"]
    app["Dashboard"]
    kv[("Key vault<br/>dashboard-… secrets")]
    st[("Storage<br/>dashboard-&lt;key&gt;")]
    roles["App roles<br/>Admin-&lt;key&gt;, User-&lt;key&gt;"]
  end
  subgraph cust["Customer tenant &lt;key&gt;"]
    capp["App registration (made by hand)<br/>Graph app permissions + admin consent"]
    csubs["Subscriptions<br/>Reader, Cost Management Reader,<br/>Key Vault Reader"]
  end
  tf["Terraform customers = {...}"] -- "DASHBOARD_TENANTS<br/>(no secrets)" --> app
  tf --> st
  tf --> roles
  admin["Admin in Settings"] -- "client secret" --> kv
  kv --> app
  app -- "client secret credential" --> capp
  capp --> csubs
```

- Terraform never touches a customer tenant; `terraform output customer_onboarding` prints the consent link and role
  commands an admin there runs once.
- Each customer's results go to its own container, so removing a customer is deleting one container.
- A tenant delegated with Azure Lighthouse can instead be scanned by the home identity like any other subscription.

## 7. Network

Default: the site is public on `https://<name>.azurewebsites.net` and storage and vault have public endpoints,
reached only with Entra tokens. Two optional layers:

- `allowed_ip_ranges` / `allowed_subnet_ids`: App Service access restrictions; everything else is refused before it
  reaches the app (the Kudu site follows the same rules).
- `private_network = true`: the web app joins a VNet and reaches storage and vault through private endpoints, whose
  public access is turned off.

```mermaid
flowchart LR
  user["Allowed IPs / subnets"] -- "HTTPS 443" --> fe["App Service front end<br/>access restrictions, TLS 1.2+"]
  fe --> app["Web app"]
  subgraph vnet["VNet (private_network)"]
    snapp["snet-app<br/>delegated to App Service"]
    snpe["snet-private-endpoints"]
    pest["Private endpoint: blob"]
    pekv["Private endpoint: vault"]
    dns["Private DNS<br/>privatelink.blob.core.windows.net<br/>privatelink.vaultcore.azure.net"]
  end
  app -- "VNet integration" --> snapp
  snapp --> pest
  snapp --> pekv
  snpe --- pest
  snpe --- pekv
  pest --> st[("Storage<br/>public access off")]
  pekv --> kv[("Key vault<br/>public access off")]
  app -- "public internet<br/>(or via VNet with vnet_route_all + NAT)" --> azure["ARM, Graph, Entra,<br/>Docker Hub, endoflife.date"]
```

With `vnet_route_all = true` all outbound traffic goes through the VNet, so that VNet needs a NAT gateway or a
firewall to reach Docker Hub, ARM and Graph. The End of support scan also fetches dates from `endoflife.date`
once a day (no tenant data is sent); if it is blocked, the scan uses its last copy or the built-in dates.

## 8. Build and release

```mermaid
flowchart LR
  dev["Commit to main<br/>(VERSION bumped)"] --> gh["GitHub<br/>Gooseankles/azure-ops-dashboard"]
  gh --> ci["Actions: Docker image<br/>build + push"]
  ci --> hub[("Docker Hub<br/>latest, &lt;version&gt;, stable")]
  ci --> tag["Git tag v&lt;version&gt;"]
  promote["Actions: Promote to stable<br/>(by hand)"] --> hub
  tfrun["terraform apply<br/>image = ...:&lt;version&gt;"] --> web["App Service"]
  hub -- "pull on restart / image change" --> web
  promote -. "deploy webhook<br/>(continuous_deployment)" .-> web
```

- Versions are `major.minor.revision.package` (feature, small change, docs only). The image tag and the git tag carry
  the same number. The Terraform module has its own versions (`v<major>.<minor>.<patch>` in its repo); set
  `image = ...:<version>` to pin the app.
- `stable` is moved by hand once a build has proven itself; nothing is rebuilt, the same image gets one more tag.
  App Services deployed with the module's `continuous_deployment = true` pull it at once: the workflow calls each
  URL in the `STABLE_DEPLOY_WEBHOOKS` secret (the module's `deploy_webhook_url` output, one per line).
- `docker.yml` also runs every Tuesday so the image gets new base-image fixes; the Node base image is pinned by
  digest and Dependabot moves it.
- Pull requests build the image but do not push it.

## 9. Inside the app (low-level design)

No build step: the server is plain Node.js (CommonJS), the front end is plain JavaScript files served as they are.

```mermaid
flowchart TB
  subgraph browser["Browser (public/)"]
    appjs["app.js<br/>routing, TOOLS, KINDS, tables"]
    views["complianceView.js, report.js,<br/>cost.js, audit.js, settings.js"]
    comp["compliance.js<br/>finding kind → NIS2 / IR / NSM / CIS"]
  end
  subgraph server["Server (server.js + src/)"]
    mw["Middleware: security headers →<br/>session → requireAuth → audit"]
    auth["auth.js / access.js<br/>SSO, local admin, roles, tenant scope"]
    reg["toolRegistry.js<br/>routes + cron per tool"]
    tools["tools/*.js<br/>39 tools: run() → findings"]
    clients["armClient.js / graphClient.js<br/>paging, retries"]
    cred["credentials.js<br/>which identity, cached"]
    ctx["tenantContext.js<br/>AsyncLocalStorage: current tenant"]
    store["findingsStore.js<br/>latest, history, diff"]
    supp["suppressions.js<br/>accepted / snoozed"]
    cost["costHistory.js"]
    rep["report.js<br/>monthly report"]
    cfg["settings.js / tenants.js /<br/>secretStore.js"]
    logs["log.js (runs.jsonl)<br/>audit.js (audit.jsonl)"]
  end
  appjs -- "fetch /api/*" --> mw
  mw --> auth
  mw --> reg
  reg --> tools
  tools --> clients
  clients --> cred
  cred --> ctx
  cred --> cfg
  reg --> store
  reg --> supp
  reg --> logs
  rep --> store
  cost --> clients
  store --> cred
```

### Tool contract

| Kind | Exports | Registered with | Routes |
|---|---|---|---|
| Scan | `{ id, label, schedule, run() }`, `run()` returns findings | `registerScanTool` | `POST /api/tools/<id>/run`, `/accept`, `/unaccept`; `GET /findings`, `/history`, `/history/<ranAt>` |
| Action | `{ id, label, registerRoutes(app) }` | `registerActionTool` | its own (Access lookup) |

A finding is a plain object: `kind` (drives label, severity and compliance tags), `id` (stable across runs, used to
diff), `name`, `detail`, and where it applies `subscriptionId`, `resourceGroup`, `principalId`. The store adds
`firstSeen`, and `tenant` for customer findings.

Adding a tool touches: `src/tools/<tool>.js`, `server.js` (register), `src/toolPermissions.js` (what it needs),
`src/settings.js` (SPN override and its settings), `public/app.js` (`TOOLS`, `KINDS`) and `public/compliance.js`
(controls per kind and `TOOL_KINDS`).

### Main API

| Route | Who | What |
|---|---|---|
| `GET /api/me` | anyone | Signed in?, roles, tenants, version |
| `GET /api/tools` | signed in | Tools and the permissions each needs |
| `GET /api/tools/<id>/findings` | signed in | Latest results for the tenants the person sees |
| `POST /api/tools/<id>/run` | Admin, Admin-key | Start a scan (202, runs in the background) |
| `GET /api/report?month=` | signed in | Monthly report |
| `GET /api/cost/history[/<sub>]` | signed in | Cost history |
| `GET/POST /api/settings`, `/api/tenants` | Admin | Settings and customer tenants (secrets go to the vault) |
| `GET /api/audit` | Admin | Audit log |
| `GET /api/logs` | signed in | Activity log, filtered to the person's tenants |

## 10. Where data is kept

```mermaid
flowchart LR
  subgraph blob["Storage account"]
    c0["dashboard/ (home)"]
    c1["dashboard-&lt;key&gt;/ (each customer)"]
  end
  subgraph files["In each container"]
    f1["findings/&lt;tool&gt;.json<br/>latest run + last error"]
    f2["history/&lt;tool&gt;/index.json<br/>counts per run"]
    f3["history/&lt;tool&gt;/&lt;ranAt&gt;.json<br/>full snapshot"]
    f4["suppressions/&lt;tool&gt;.json<br/>accepted, snoozed"]
    f5["cost history documents"]
  end
  subgraph disk["/home/data on App Service"]
    d1["settings.json, tenants.json<br/>(no secrets when the vault is on)"]
    d2["sessions/"]
    d3["logs/runs.jsonl, logs/audit.jsonl"]
  end
  kv[("Key vault<br/>dashboard-* secrets")]
  c0 --- files
  c1 --- files
```

| Data | Kept | How long |
|---|---|---|
| Scan results and history | Blob (or `DATA_DIR`) | `HISTORY_RETENTION_DAYS`, default 365 |
| Cost history | Blob (or `DATA_DIR`) | As long as you like |
| Secrets typed in Settings | Key vault (or the JSON files when no vault) | Until changed |
| Settings, sessions | `/home/data` | Sessions 8 h |
| Activity log, audit log | `/home/data/logs` | Audit: `AUDIT_RETENTION_DAYS`, default 365 |

`/home` on App Service is persistent shared storage (`WEBSITES_ENABLE_APP_SERVICE_STORAGE=true`), so settings,
sessions and logs survive restarts and new images. With more than one instance they would be shared, but the
scheduler is in-process (every instance would run every scan), so run **one instance**: scale the plan up, not out.

## 11. Security controls in short

| Area | Control |
|---|---|
| Secrets | None for the home tenant (managed identities, federated credential); customer secrets only in the key vault; storage account keys off |
| Least privilege | Read-only ARM roles and Graph permissions; optional per-tool identities; the vault role is on that one vault |
| Sign-in | Entra with PKCE and state check; assignment required and an app role required; local admin rate-limited |
| Sessions | Server-side, httpOnly, Secure on HTTPS, SameSite=Lax, 8 hours, regenerated at sign-in |
| Browser | Strict Content-Security-Policy (own scripts only), no framing, nosniff, HSTS |
| Tenant isolation | One container per customer; every read and run checks the person's tenant scope |
| Traceability | Audit log of sign-ins, page views, lookups and changes (never secret values); activity log of every scan |
| Network | HTTPS only, TLS 1.2+, FTPS off; optional IP restrictions and private endpoints |
| Container | Alpine Node 26 with security updates, production dependencies only, no npm, runs as non-root `node`; Trivy scan before every push (results in the GitHub Security tab), Dependabot weekly |
