# 0004. Access by area and by tenant, with roles in Entra

- Status: accepted
- Date: 2026-10-28

## Context

Different teams look after identity, the platform, security and cost. They should see their own scans without
seeing everything, and customers should see only their own tenant. Access should be managed where the organization
already manages it.

## Decision

Roles are Entra app roles on the sign-in app: `Admin`, `User`, `Admin-<key>`, `User-<key>`, and `<Area>.Read`
or `<Area>.Read-<key>` for the areas Identity, Platform, Security and Cost. Which scans each area holds is in
`TOOL_AREAS` (`src/access.js`). Whoever may see a scan may run it and accept its findings. The `<Area>.Run` roles
of 0.53 were dropped in 0.57.0.0: running a read-only scan shows nothing that reading it does not. Settings stay with
`Admin`. With Terraform each role gets a security group.

## Consequences

- Access is given by adding people to Entra groups; the dashboard keeps no user list.
- A role change applies at the next sign-in.
- A scan can belong to more than one area. A new tool needs an area; `npm run docs` fails without one.
