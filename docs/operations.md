# Operations

Running Cirrus Watch day to day: upgrading, rolling back, backing up, rotating secrets and keeping an eye on it.
How the deployment is wired is in the [setup low-level design](lld-setup.md); where each piece of data lives is in
[data.md](data.md).

## Run one instance

The schedules run inside the web process, so keep the App Service plan at one instance. Two instances would run
every scan twice and write the same files ([ADR 0006](adr/0006-one-process-one-instance.md)). If it is slow, scale
up (a bigger plan), not out.

## Upgrade

1. Read the [changelog](../CHANGELOG.md), above all the **Upgrading** section, for every version between yours and
   the new one. For a new module version, read the
   [module changelog](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard/blob/main/CHANGELOG.md) too.
2. Pick the image:
   - `stable` (the module default): promoted by hand once a build has proven itself. With
     `continuous_deployment = true` the site pulls a new stable by itself; otherwise restart the web app.
   - A version tag such as `0.57.1.0`: set `image` in Terraform (or the web app's container settings) and apply.
     Nothing changes until you change it again.
   - `latest`: every push to `main`. For testing only.
3. Raise the module `?ref=` separately from the image, run `terraform plan`, read what it will change, then apply.
4. After the restart, open the dashboard: the version is bottom left. Check Recent activity for errors and run one
   scan with **Run now**. `https://<site>/health` should answer `{"status":"ok"}`.

Everything in `DATA_DIR` and the storage account stays; sign-ins survive a restart.

## Roll back

Set `image` to the version you ran before (each version is its own image tag) and apply, or set it on the web
app's Deployment Center. Results written by the newer version stay readable. If the changelog's Upgrading section
lists a one-way change for that version, follow what it says there.

For the module, set `?ref=` back to the previous tag and plan; read the plan carefully, because a module rollback
can recreate or remove Azure and Entra objects.

## Back up and restore

| What | Where | How to back it up |
| --- | --- | --- |
| Scan results, history, cost history, accepted findings | Storage account, container `dashboard` and one `dashboard-<key>` per customer | Copy the containers, for example `azcopy login` then `azcopy copy "https://<account>.blob.core.windows.net/dashboard" ./backup --recursive` (needs Storage Blob Data Reader; account keys are off). Deleted blobs can be restored for 7 days (blob soft delete) |
| Settings, customer list, notification links (without a vault), sessions, sign-in key, logs | `DATA_DIR` (`/home/data` on App Service) | App Service backups, or download the folder through the Kudu (scm) site. Without storage and vault settings this folder holds everything |
| Secrets typed in Settings | Key vault `dashboard-…` secrets | Kept for 90 days after deletion (soft delete), except that **Remove** on a customer tenant also purges its secrets; turn on `secret_vault_purge_protection` to make the vault keep them for the 90 days anyway |
| The setup itself | Terraform configuration and state | Your Terraform backend |

To restore, copy the containers back into the storage account (same names) and the files back into `DATA_DIR`,
then restart the web app.

Removing a customer is done in two places, and nothing of theirs is kept. Settings → Customer tenants → **Remove**
(Admin) deletes everything the dashboard holds for the tenant: its client secret and notification link (purged from
the vault, not only soft-deleted), its container `dashboard-<key>` with results, history, accepted findings and cost
history (containers have no soft delete, so this is final), its own settings and its activity-log lines; the tenant
leaves every page at once. Then remove the key from `customers` in Terraform and apply: that deletes its roles and
groups (the app cannot; it only reads Entra). Until that apply the app ignores the tenant and lists it as "Removed,
waiting for Terraform". Removing a key from `customers` without the Remove button also deletes the container and
its history (Terraform destroys it), but leaves the secret in the vault's soft-delete bin and the tenant's lines in
the activity log. Copy the container first if it must be kept; the steps are in
[Customer tenants](guides/customer-tenants.md#remove-a-customer).

## Rotate secrets

| Secret | When | How |
| --- | --- | --- |
| A customer tenant's client secret | Before it expires (the customer's app registration shows the date) | The customer makes a new secret; paste it in Settings → Customer tenants → Edit; press **Test**; the customer deletes the old one |
| A per-tool SPN secret | Before it expires | New secret on that app registration, paste it in Settings → SPN override, **Test** |
| Notification link | When it may have leaked | Make a new link in Teams, Slack or the endpoint; paste it in Settings → Notifications; **Send test**; delete the old one there |
| `SESSION_SECRET` | When it may have leaked | `terraform apply -replace='module.dashboard.random_password.session_secret'` (use your module name). Everyone must sign in again |
| Local admin password | When it may have leaked, or once SSO works | Change or remove `admin_password` / `DASHBOARD_ADMIN_PASSWORD`; the app restarts |
| SSO | Never with the module: it is secretless | With a client secret instead (`sso_client_secret`), make a new one, apply, then delete the old one |

The managed identities have no secrets to rotate.

## Audit log

Admin → **Audit log** shows who signed in (and refused or failed sign-ins), which pages they opened (each scan,
the monthly report, cost history, a past run, a subscription's cost), whom they looked up in Access lookup, and
what they changed: Run now, accepted, snoozed and reopened findings, settings (which ones, never the values),
customer tenants and Test buttons. A refused request (403) is kept too. Opening the same page again within ten
minutes counts once. Kept `AUDIT_RETENTION_DAYS` (default 365); only Admin can read it.

## Server load and alarms

Admin → **Server load** watches the dashboard's own App Service: CPU and memory of the instance, the dashboard's
own memory and heap, and how quickly it answers (event-loop delay), sampled every 15 seconds and kept 48 hours as
the worst value of each minute. Each point and each scan run records which scans were running, so the page shows
which scan pushed the load up, with a timeline, the peak of every run and a list of restarts (marked when the
previous one did not stop cleanly, for example out of memory). An alarm goes to Recent activity, with the
scans running at the time, when CPU stays above `MONITOR_CPU_WARN_PCT` (90) for 5 minutes, memory or heap passes
`MONITOR_MEMORY_WARN_PCT` (85), or answers take longer than `MONITOR_LAG_WARN_MS` (2000); another line follows when
it is back to normal. For email, set `alert_emails` in Terraform (see the module's README, Load alarms and health check).

The Azure Monitor alerts (`alert_emails`) watch the same App Service from outside, so they also arrive when the app
itself is stuck.

## Health check

`GET /health` needs no sign-in. It answers 200 `{"status":"ok"}`, or 503 `{"status":"stale"}` when no scheduled
scan has finished well (at least one tenant saved) for `HEALTH_SCAN_MAX_AGE_HOURS` (default 26: a day of nightly
scans plus slack). It is always ok in the first 26 hours after a start, so a restart is not reported. **Run now** does
not count: only the schedules show that the app keeps working by itself. The answer says nothing else: no tenants,
findings or version.

The Terraform module sets App Service's health check path to `/health` and adds the alert **Health check status**
(below 100% for 15 minutes), sent to `alert_emails`. That module version needs app 0.61.0.0 or newer: an older app
answers `/health` with the sign-in page. With one instance App Service keeps the app in service, but it may restart
it while it stays unhealthy. Without the module, point any uptime check at `/health`.

Two limits keep a stuck scan from blocking the others:

- Each ARM or Graph request gives up after `AZURE_REQUEST_TIMEOUT_SECONDS` (60) and is tried again (a Graph POST is
  not). Storage requests give up after 30 seconds and are tried again too, as on 429 and 5xx.
- Each tenant's scan run has a deadline, `SCAN_DEADLINE_MINUTES` (45) unless the tool sets its own. Past it the
  tenant gets "scan timed out" and keeps its last results. "Already running" now means a run that started less than
  the deadline ago and has not ended. After the deadline the next schedule or **Run now** starts again, even if the
  late run is still going in the background; what it returns is thrown away.

## Keep the image up to date

Builds of `main` get new Alpine and Node.js fixes every week and are scanned with Trivy before they are pushed.
Follow `stable` with `continuous_deployment`, or move your version tag along with the changelog. How the repository
keeps its own dependencies up to date is in [CONTRIBUTING.md](../CONTRIBUTING.md#how-the-repository-stays-up-to-date).

## When something is wrong

Start with Recent activity (scan errors, alarms, failed notifications) and the scan page's error box (it lists the
permissions the scan needs). Then see [troubleshooting.md](troubleshooting.md). The container's own output is in
App Service → Log stream.
