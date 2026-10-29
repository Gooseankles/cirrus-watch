# 0002. Managed identity first

- Status: accepted
- Date: 2026-10-20

## Context

An identity with a client secret needs the secret stored somewhere, rotated before it expires, and kept out of
logs and state. On App Service a managed identity gets tokens without any secret.

## Decision

In the home tenant the scans use the web app's system-assigned managed identity. Sign-in uses a user-assigned
managed identity that the sign-in app registration trusts through a federated credential, so SSO needs no client
secret either. A client secret is used only where Azure offers nothing else (customer tenants,
[0005](0005-customer-tenants-own-app-registration.md)) or when the app runs outside Azure.

## Consequences

- A Terraform deployment has no secrets for the home tenant.
- Two identities on one web app take some explaining; [lld-setup.md](../lld-setup.md) does that.
- Graph permissions granted to a managed identity reach its token only after up to 24 hours.
