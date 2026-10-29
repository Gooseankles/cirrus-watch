# Architecture decision records

Each record holds one decision: the situation, what was decided, and what follows from it. An accepted record is not
rewritten; a new record replaces it, and the old one gets the status "Superseded by NNNN". The date is when the
decision was made; the records were written down on 2026-10-29.

To add one, copy the newest record, take the next number and keep the three sections: Context, Decision,
Consequences. Add it to the table below and, if it changes the big picture, to the [high-level design](../hld.md).

| Number | Decision | Date |
| --- | --- | --- |
| [0001](0001-scans-only-read.md) | Scans only read | 2026-10-20 |
| [0002](0002-managed-identity-first.md) | Managed identity first | 2026-10-20 |
| [0003](0003-secrets-in-key-vault-not-terraform.md) | Secrets typed in Settings go to Key Vault, never into Terraform | 2026-10-21 |
| [0004](0004-access-areas.md) | Access by area and by tenant, with roles in Entra | 2026-10-28 |
| [0005](0005-customer-tenants-own-app-registration.md) | Each customer tenant has its own app registration | 2026-10-21 |
| [0006](0006-one-process-one-instance.md) | One process, one instance, no database | 2026-10-20 |
| [0007](0007-versioning.md) | Four-part app version, semver for the module | 2026-10-23 |
| [0008](0008-agpl-licence.md) | AGPL-3.0-only for the app | 2026-10-28 |
