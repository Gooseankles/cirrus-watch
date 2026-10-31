# Sign-in and roles

Who can sign in, what each role sees, and how to set up sign-in with Entra ID. The roles are the same for the
local admin account and SSO; with Terraform, the module makes the app registration, the roles and a group per role.

## Roles

- **Admin**: every tenant, plus the Settings page (the only role that adds or removes customer tenants).
- **User**: every tenant.
- **Admin-&lt;key&gt;** / **User-&lt;key&gt;**: one customer tenant (see [Customer tenants](customer-tenants.md)).
- **&lt;Area&gt;.Read**: one area in every tenant.
- **&lt;Area&gt;.Read-&lt;key&gt;**: one area in one tenant.

Whoever may see a scan may also run it (Run now, cost history refresh). The `<Area>.Run` roles of older versions
still work and count as `<Area>.Read`.

Areas let each team see only its own scans. Area is `Identity`, `Platform`, `Security` or `Cost`; a scan can sit in
more than one (`TOOL_AREAS` in `src/access.js`):

| Area | Scans |
| --- | --- |
| Identity | Access lookup, access review, secret expiry, access packages, role assignments, PIM, stale accounts, tenant settings, licence coverage, privileged roles, app permissions, Conditional Access, MFA coverage |
| Security | Privileged roles, app permissions, Conditional Access, MFA coverage, Defender for Cloud, internet exposure, exposure paths, firewall policies, network hygiene, Key Vault, resource settings, diagnostic settings, change log |
| Platform | Defender for Cloud, internet exposure, exposure paths, firewall policies, network hygiene, Key Vault, resource settings, diagnostic settings, change log, IPAM, tags, end of support, service retirements, certificates, backup coverage, resilience, updates, resource health, connectivity health, architecture, policy check, safety nets, Azure Monitor, subscriptions, quotas, orphaned resources, cost anomalies, cost history |
| Cost | Orphaned resources, cost anomalies, cost history |

Whoever may see a scan may also run it and accept or snooze its findings. Settings stays with `Admin`; the server
log lines and notifications are shown to `Admin` and `User`.

A person can hold several roles, for example `User-acme` and `Admin-globex`, and then sees only those tenants.
Role values are matched without regard to case. An SSO account with no role is refused, even when the Enterprise
App does not require assignment. With Terraform, each role gets an Entra security group (`create_role_groups`), so
access is given by adding people to groups.

Two ways to sign in, either or both: a local admin account and SSO.

## Local admin account

Set `DASHBOARD_ADMIN_PASSWORD`. The username is always `admin` and it always has the Admin role. Handy before SSO
exists or as a break-glass login; leave it blank to turn it off. Use a strong password if the dashboard is
reachable by anyone else. After 10 wrong passwords from one address, that address must wait 15 minutes.

## SSO with an Entra ID app registration

This is a separate app registration from the identity the scans use: it only signs people in to the dashboard.

1. Entra ID → App registrations → New registration. Add a redirect URI of type **Web**:
   `https://<your host>/auth/callback` (for local use `http://localhost:7070/auth/callback`). It must match
   `DASHBOARD_REDIRECT_URI` exactly.
2. Either create a client secret (`DASHBOARD_AZURE_CLIENT_SECRET`), or, on App Service, go secretless: attach a
   user-assigned managed identity to the web app, add a federated credential for it on the app registration
   (scenario "Managed identity") and set its client ID as `DASHBOARD_FEDERATED_MI_CLIENT_ID`.
3. App roles → create `Admin` and `User`, plus `Admin-<key>` and `User-<key>` per customer tenant and the area
   roles you want (`Security.Read`, `Platform.Read-acme` and so on) (allowed member types: Users/Groups).
4. Set `DASHBOARD_AZURE_TENANT_ID` and `DASHBOARD_AZURE_CLIENT_ID`.
5. Enterprise applications → this app → Properties → **Assignment required** = Yes, so only people you add can
   sign in.
6. Users and groups → assign people or groups to Admin or User. Roles live only in Entra; the dashboard reads the
   `roles` claim on the ID token.

Related: [Customer tenants](customer-tenants.md), [Troubleshooting](../troubleshooting.md#sign-in),
[architecture: signing in](../architecture.md#4-signing-in).
