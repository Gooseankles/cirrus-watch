# Security

## Reporting a problem

Please do not open a public issue for a security problem. Report it privately through GitHub instead:
**Security** tab → **Report a vulnerability**. Include what you found, how to reproduce it and the version
(`VERSION`, or the image tag) you tested.

This is a free project kept by one person in their spare time, so there is no bug bounty and no fixed response
time. You can expect a reply within a couple of weeks, a fix in the newest release when the report holds up, and
credit in the fix if you want it. Please give a reasonable time to fix before telling others.

Test only against a copy you run yourself, never against someone else's deployment.

## Supported versions

Only the newest release (the `stable` image tag and the newest `main`) gets security fixes.

## Running it safely

Cirrus Watch reads a lot about a tenant: users, roles, apps, networks and costs. Treat access to it like read access
to the tenant.

- **Sign-in:** use SSO with Entra (`DASHBOARD_AZURE_*`), so the tenant's MFA and Conditional Access apply. The local
  admin login is meant for setup: give it a long random password (the app warns at startup when it is shorter than
  16 characters), or leave `DASHBOARD_ADMIN_PASSWORD` unset to turn it off once SSO works.
- **Roles:** give people the narrowest app role that fits (`User-<key>`, an area role) rather than `Admin`.
- **Session key:** set `SESSION_SECRET` to a long random value (the Terraform module does). Without one the app
  makes its own and keeps it in `DATA_DIR/session-secret`.
- **Network:** serve it over HTTPS only, and let in only the addresses that need it (the Terraform module's
  `allowed_ip_ranges` and `allowed_subnet_ids` refuse everything else before it reaches the app).
- **The app's own identity:** grant only what the scans need (Reader, Cost Management Reader and the Graph
  read permissions in [docs/permissions.md](docs/permissions.md)). It needs no write rights anywhere.
- **Updates:** run the `stable` image and update it regularly. Every image is scanned by Trivy before it is pushed,
  the image is rebuilt every week for new Alpine and Node fixes, and CodeQL checks the code on every push.
- **Cross-site requests:** a request that changes something (POST, PUT, DELETE) must come from the dashboard's own
  pages (the browser's `Sec-Fetch-Site` or `Origin`); others get 403. The session cookie is `SameSite=Lax` as well.
- **Audit:** sign-ins, Run now, accepted findings and settings changes go to the audit log; review it now and
  then.
