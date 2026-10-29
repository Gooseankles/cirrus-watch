# 0008. AGPL-3.0-only for the app

- Status: accepted
- Date: 2026-10-28

## Context

The code is public. A dashboard is usually offered to others over a network (to customers, as a service). Under a
permissive licence or the plain GPL, a changed version offered that way would not have to be shared.

## Decision

The app is licensed AGPL-3.0-only. The Terraform module, which holds no app code, is MIT.

## Consequences

- Anyone who changes the app and lets others use it over a network must offer them the source.
- Using it unchanged inside an organization adds no duty.
- Contributions come in under the same licence.
