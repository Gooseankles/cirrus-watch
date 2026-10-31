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
  16 characters), or leave `DASHBOARD_ADMIN_PASSWORD` unset to turn it off once SSO works. Wrong passwords are
  limited per address (10 in 15 minutes) and across all addresses (after 50 in 15 minutes, every address that sent a
  wrong password is refused until the window ends; an address with none, and SSO, keep working); see
  [Sign-in and roles](docs/guides/sign-in-and-roles.md#local-admin-account).
  Sign-in errors show the browser a reference only; the detail is in the server log.
- **Roles:** give people the narrowest app role that fits (`User-<key>`, an area role) rather than `Admin`.
- **Session key:** set `SESSION_SECRET` to a long random value (the Terraform module does). Without one the app
  makes its own and keeps it in `DATA_DIR/session-secret`.
- **Network:** serve it over HTTPS only, and let in only the addresses that need it (the Terraform module's
  `allowed_ip_ranges` and `allowed_subnet_ids` refuse everything else before it reaches the app). The strictest
  option is `app_private_endpoint`: the site's access restrictions deny every network, so it is reached only through
  the VNet (VPN, ExpressRoute or peering) and any addresses you allow.
- **The app's own identity:** grant only what the scans need (Reader, Cost Management Reader and the Graph
  read permissions in [docs/permissions.md](docs/permissions.md)). It needs no write rights anywhere.
- **Updates:** run the `stable` image and update it regularly. Every image is scanned by Trivy before it is pushed,
  the image is rebuilt every week for new Alpine and Node fixes, and CodeQL checks the code on every push. Each
  pushed image carries an SBOM and build provenance (`docker buildx imagetools inspect`), and the workflows pin
  every action to a commit SHA. Each pushed image is signed (see [Check the image signature](#check-the-image-signature)),
  and `stable` only ever points at a signed image. To pin the image itself, use its digest
  (`trozity/azure-ops-dashboard@sha256:...`) after checking its signature.
- **Deployments:** the Terraform module's `continuous_deployment` restarts the app from GitHub Actions with a
  federated identity that may only read and restart that one web app; the site's publishing password (basic
  authentication) stays off.
- **Cross-site requests:** a request that changes something (POST, PUT, DELETE) must come from the dashboard's own
  pages (the browser's `Sec-Fetch-Site` or `Origin`); others get 403. The session cookie is `SameSite=Lax` as well.
- **Audit:** sign-ins, Run now, accepted findings, settings changes and notification link changes go to the audit
  log (never secret values or the notification link itself); review it now and then.
- **No open API routes:** every `/api/` route needs a session, `/api/me` too. The login page asks `/auth/methods`,
  which says only which sign-in methods are set up.

## Check the image signature

Every image `docker.yml` pushes (versions after 0.64.1.0) is signed with [Sigstore cosign](https://docs.sigstore.dev/),
keyless: GitHub's OIDC token gives the workflow a short-lived certificate that names this repository, the workflow
file and the branch or tag, and the signature is recorded in the public Rekor log. There is no signing key to
steal. The image is signed by digest, so the signature covers those exact bytes, whatever tag points at them.

Check an image before you run or pin it (needs [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3
or newer; cosign 2 does not read the newer signature format and reports "no signatures found"):

```sh
cosign verify trozity/azure-ops-dashboard:<version> \
  --certificate-identity-regexp '^https://github\.com/Gooseankles/cirrus-watch/\.github/workflows/docker\.yml@refs/(heads/main|tags/v.+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

It prints the verified signature (with the digest it covers) or fails. To pin, use that digest:
`trozity/azure-ops-dashboard@sha256:<digest>`. App Service does not check signatures when it pulls; the
**Promote to stable** workflow runs the same check before it moves `stable`, and refuses an image that fails it,
so 0.64.1.0 and older (pushed before signing) cannot become `stable`.
