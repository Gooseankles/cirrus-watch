# Azure tools dashboard

A local dashboard for home-grown Azure automations, built around a single
service principal plus a Microsoft Graph app registration. Tools:

| Tool | Kind | What it does |
|---|---|---|
| Subscription creation | ServiceNow-triggered | Turns a subscription-request ticket into a real Azure subscription |
| Subscription decommission | ServiceNow-triggered | Cancels a subscription once a safety checklist is confirmed |
| Orphaned resources | Scan (nightly) | Unattached disks, unused public IPs, orphaned NICs, empty resource groups |
| Tag compliance | Scan (nightly) | Resources missing required tags (`CostCenter`, `Owner`, `Environment` by default) |
| Cost anomalies | Scan (nightly) | Resource groups whose daily spend jumped more than a threshold |
| Access review | Scan (weekly) | Stale direct Owner/Contributor grants on users (not via a group) |
| Expiring secrets/certs | Scan (nightly) | App registration secrets and Key Vault certs expiring soon |
| Access packages | Scan (nightly) | Entra access-package assignments expiring soon, requests stuck pending approval, packages nobody uses, duplicate-named packages, auto-approved policies that never expire, and policies with only one possible approver |
| Access lookup | On-demand | Paste a UPN, see every role assignment they have, direct or via group |

Scan tools show their findings on the dashboard with a "Run now" button so
you don't have to wait for the nightly schedule while testing.

## Signing in and roles

The dashboard itself now requires signing in — two roles:

- **Admin** — everything a User can see, plus triggering "Run now" on scan
  tools and editing the thresholds on the Settings tab.
- **User** — read-only: views findings, logs and the access-lookup tool.

Two ways to sign in, and you can have either or both configured at once:

### Quick local admin account

Set `DASHBOARD_ADMIN_PASSWORD` in `.env`. Username is always `admin`; it's
always the Admin role. This is the fastest way to use the dashboard before
the Enterprise App below exists, or as a break-glass login if Entra is ever
unreachable. **Change the password before this dashboard is reachable by
anyone but you** — it's currently set to `password123` as a placeholder.

### SSO via an Entra ID Enterprise App

This is a separate App Registration from the SPNs the scan tools use — this
one is a user-facing sign-in app, not a service principal:

1. Azure AD → App registrations → New registration. Name it something like
   "Azure tools dashboard". Add a redirect URI of platform type **Web**:
   `http://localhost:7070/auth/callback` (must match `DASHBOARD_REDIRECT_URI`
   in `.env` exactly).
   On App Service use `https://<app>.azurewebsites.net/auth/callback`.
2. Certificates & secrets → new client secret. Or, without a secret on App
   Service: create a user-assigned managed identity, attach it to the web
   app, then under Certificates & secrets → Federated credentials → Add →
   scenario "Managed identity" → pick it. Set its client ID as
   `DASHBOARD_FEDERATED_MI_CLIENT_ID` instead of `DASHBOARD_AZURE_CLIENT_SECRET`.
3. App roles → create two:
   - `Admin` (value `Admin`, allowed member type: Users/Groups)
   - `User` (value `User`, allowed member type: Users/Groups)
4. Put the tenant ID, this app's client ID and the secret in `.env` as
   `DASHBOARD_AZURE_TENANT_ID` / `DASHBOARD_AZURE_CLIENT_ID` /
   `DASHBOARD_AZURE_CLIENT_SECRET`.
5. Azure AD → Enterprise applications → this app → **Properties** → set
   "Assignment required?" to **Yes**, so only people you explicitly add can
   sign in at all.
6. Same app → **Users and groups** → Add user/group → assign each person (or
   a group) to either the Admin or User role. This is also how you manage
   role membership going forward — nothing about roles lives in this app's
   own code or database, it only reads the `roles` claim Entra puts on the
   ID token.

A person with no role assigned can't sign in at all (step 5); a person
assigned to neither Admin nor User explicitly won't get write access to
anything even if they do sign in.

## How the ServiceNow-triggered tools work

1. Someone raises a ServiceNow ticket (e.g. a Catalog request) asking for a
   new Azure subscription.
2. A ServiceNow Business Rule or Flow Designer flow calls this app's webhook
   (`POST /webhook/create-subscription`) with the ticket number and the
   subscription's display name.
3. This app calls Azure's `Microsoft.Subscription/aliases` API to create the
   subscription, under a billing scope your service principal is allowed to
   create subscriptions against.
4. It writes a work note back onto the ticket, and logs every step to
   `logs/runs.jsonl`, visible live on the dashboard at `http://localhost:7070`.

## 1. Get a test ServiceNow instance

Sign up for the free ServiceNow Developer Program at
https://developer.servicenow.com and request a **Personal Developer Instance
(PDI)**. It comes with admin rights and the REST/Table API enabled. Enable
the ITSM plugin (Incident/Request/Catalog tables) if it isn't already, so
you have something ticket-shaped to test against. PDIs hibernate after about
two weeks of no login — just log in to wake one back up.

Create a dedicated API user for this integration (don't use your personal
PDI login): **User Administration > Users** → new user, give it the
`rest_api_explorer` and `itil` roles (or whatever table access it needs),
put its credentials in `.env` as `SNOW_API_USER` / `SNOW_API_PASSWORD`.

## 2. Wire up the ServiceNow side

In the PDI, add a Business Rule (or Flow Designer flow) on your subscription
request table that, on insert/update matching your criteria, does an
outbound REST call:

- URL: wherever this app is reachable (for local testing, your PC's LAN IP
  and port, e.g. `http://10.0.0.10:7070/webhook/create-subscription`)
- Method: `POST`
- Header: `X-Webhook-Secret: <same value as WEBHOOK_SHARED_SECRET in .env>`
- Body:
  ```json
  {
    "ticketNumber": "${number}",
    "table": "${table_name}",
    "sysId": "${sys_id}",
    "displayName": "${short_description}"
  }
  ```

## 3. Set up the Azure side

This creates **real Azure subscriptions**, which requires an app
registration with rights on a billing account:

1. Azure AD → App registrations → New registration. Create a client secret.
2. The subscription-creation API needs the app to have a role (e.g.
   **Subscription Creator** or **Azure subscription creator**) assigned at
   the billing scope — an EA enrollment account, or an MCA billing
   profile/invoice section. This is a billing-admin action in your Azure
   tenant (ask whoever manages billing if you're not that person).
3. Put the tenant ID, client ID, client secret and billing scope path in
   `.env` (see `.env.example` for the exact scope formats for EA vs MCA).

Until that billing-scope role assignment exists at work, you can still build
and test everything else (webhook receiving, logging, dashboard, ServiceNow
work notes) — only the final `createSubscription` call will fail, visible
as an `error` row in the dashboard with the real Azure error message.

## Subscription decommission

Same shape as creation, but ServiceNow posts to
`POST /webhook/decommission-subscription` and must include a completed
safety checklist — the request is refused (no Azure call made) if any of
these three aren't `true`:

```json
{
  "ticketNumber": "REQ0010099",
  "table": "sc_request",
  "sysId": "abc123",
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "checklist": {
    "backupsConfirmed": true,
    "dnsRemoved": true,
    "budgetAlertsCleared": true
  }
}
```

## Using a separate service principal per tool (least privilege)

By default every tool authenticates as the one SPN in `.env`
(`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`). That's fine
to start with, but it means one SPN ends up holding both "can create
subscriptions against the billing account" and "can read every
subscription's resources" — more than any single credential should need.

Give a tool its own SPN by setting `<TOOL_ID>_AZURE_TENANT_ID` /
`_AZURE_CLIENT_ID` / `_AZURE_CLIENT_SECRET` in `.env`, where `<TOOL_ID>` is
the tool's id in SCREAMING_SNAKE_CASE (see `.env.example` for the exact
list and an example). A tool with no override keeps using the shared SPN,
so you can migrate one tool at a time. In practice:

- `subscription-create` / `subscription-decommission` need their own SPN
  with the billing-scope role — keep that one separate from everything else.
- The scan tools (`orphaned-resources`, `tag-compliance`, `cost-anomaly`,
  `access-review`, `secret-expiry`, `access-packages`) and `access-lookup`
  only ever need read access, so they can safely share one read-only SPN
  even if you don't split every tool out individually.

## Permissions the scan/lookup tools need

These reuse the same service principal as the subscription tools, but need
broader read access:

- **ARM (orphaned resources, tag compliance, cost anomalies, access review,
  access lookup, Key Vault cert part of secret expiry):** `Reader` on every
  subscription you want scanned (or at a management group covering them).
  Cost anomalies additionally need `Cost Management Reader`.
- **Microsoft Graph (secret expiry's app-registration part, access
  lookup's user/group resolution):** Application permissions
  `Application.Read.All` and `User.Read.All` (or `Directory.Read.All`
  covers both), granted admin consent in Azure AD → App registrations →
  your app → API permissions.
- **Microsoft Graph (access packages):** `EntitlementManagement.Read.All`,
  same admin-consent process. This only returns anything if your tenant
  has Entra ID Governance / P2 licensing with access packages actually set
  up — an empty result on a tenant without entitlement management configured
  is expected, not a bug.
- **Key Vault (secret expiry only):** an access policy or RBAC role
  (`Key Vault Certificates Officer` or `Reader` + `Key Vault Secrets User`)
  granting the service principal `certificates/list` and `certificates/get`
  on each vault you want scanned.

Without these, the affected tool logs a clear `error` entry rather than
silently showing nothing — check the tool's tab or `/api/logs` if a scan
comes back empty when you expected findings.

## Run it

```
cd C:\github\azure-ops-dashboard
npm install
copy .env.example .env   REM then fill in .env
npm start
```

Open **http://localhost:7070** to watch runs come in.

## Notes

- Logs are append-only JSON lines in `logs/runs.jsonl`; the dashboard polls
  `/api/logs` every 5 seconds. Scan tool findings are separate — last-run
  results live in `data/findings/<tool-id>.json` and are what the dashboard's
  per-tool tables show. Settings-tab overrides live in `data/settings.json`
  (also gitignored, under `data/`).
- `.env` is gitignored — never commit real secrets.
- Sessions are in-memory (`express-session`'s default store) — restarting
  the server signs everyone out. Fine for a single-box local dashboard; swap
  in a real session store first if this ever runs as more than one process.
- Scheduled scans use `node-cron` and only run while `npm start` is left
  running (no OS-level task needed, but also no persistence across a reboot
  unless you run this as a service).
- Adding a new tool: scan tools go in `src/tools/*.js` exporting
  `{ id, label, schedule?, run() }` and get registered with
  `registerScanTool` in `server.js`; on-demand tools export
  `{ id, label, registerRoutes(app) }` and use `registerActionTool`. Add its
  tab to the `SCAN_TOOLS`/`STATIC_TABS` lists in `public/index.html`.
