# 0003. Secrets typed in Settings go to Key Vault, never into Terraform

- Status: accepted
- Date: 2026-10-21

## Context

Some secrets cannot be avoided: customer client secrets, per-tool SPN secrets and notification links (they carry
their own signature). Anything passed to Terraform ends up in plain text in its state file, which is often shared
with a team or a pipeline.

## Decision

These secrets are typed only into the Settings page. With `SECRET_VAULT_URL` set (the module creates a vault) they
are stored in Key Vault as `dashboard-…` secrets, read and written by the web app's managed identity. Without a vault
they stay in the JSON files under `DATA_DIR`. Secrets found in those files move to the vault at start-up. The API
says whether a secret is set and never returns it.

## Consequences

- The Terraform state never holds a customer's secret.
- Adding a customer takes two steps: Terraform, then pasting the secret in Settings.
- The app starts without the vault and retries every minute; a scan that needs a secret says the vault is not
  reachable.
- `SESSION_SECRET` and an optional SSO client secret are still in the state; they belong to the deployment, not to a
  customer.
