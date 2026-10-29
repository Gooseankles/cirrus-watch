# Where data is kept

What the dashboard stores, where, and for how long. Back-up and restore steps are in
[operations.md](operations.md#back-up-and-restore); the layout inside a container is in
[architecture.md](architecture.md#10-where-data-is-kept).

- **Scan results and run history, cost history**: in an Azure Storage blob container when `STORAGE_ACCOUNT_URL` is
  set (reached with an Entra token; account keys can stay off), otherwise under `DATA_DIR` (default `./data`).
  Each customer tenant has its own container, `dashboard-<key>` (on disk `DATA_DIR/tenants/<key>`), so one
  customer's data never sits next to another's. Runs are kept for `HISTORY_RETENTION_DAYS` (default 365; the Terraform module sets 730).
  With Terraform's `private_network = true` the storage account is reached only through a private endpoint and
  its public network access is off.
- **Client secrets and notification links entered in Settings** (SPN overrides, customer tenants, notifications): in an Azure key vault when
  `SECRET_VAULT_URL` is set (Terraform creates one; the app reads and writes it with its managed identity, as
  secrets named `dashboard-…`), otherwise in `settings.json` / `tenants.json` under `DATA_DIR`. Secrets already in
  those files move to the vault at start-up, and are removed from the file once the vault has them. If the vault
  cannot be reached, the dashboard still starts, says so on the tools that need a secret, refuses to save new
  secrets and retries every minute. `GET /api/secret-store` (Admin) shows which store is in use.
- **Accepted and snoozed findings**: with each tenant's scan results (`suppressions/<tool>.json`).
- **Other Settings page overrides and sign-in sessions**: under `DATA_DIR`. A sign-in ends after 8 hours without use
  and at the latest 24 hours after signing in. In Docker, map `DATA_DIR` to a volume, or every image update signs
  everyone out.
- **Cleanup savings** (orphaned resources deleted after they were found): `savings/orphaned-resources.json` per tenant.
- **Activity log** (scan runs): JSON lines in `runs.jsonl`, under `DATA_DIR/logs` when `DATA_DIR` is set, otherwise `./logs`.
- **Audit log** (who opened and changed what): `audit.jsonl` next to it, kept `AUDIT_RETENTION_DAYS`.

`.env`, `data/` and `logs/` are ignored by git; never commit real secrets.
