# 0009. Signed images, and deployment without the publishing password

- Status: accepted
- Date: 2026-10-31

## Context

The image is public on Docker Hub and App Service pulls it by tag. Nothing proved that an image under a tag was the
one this repo built, and App Service does not check signatures when it pulls. Continuous deployment (module
`continuous_deployment`) used App Service's deploy webhook: it turned on basic authentication for the Kudu (scm)
site, kept the scm site open past the access restrictions, and the webhook URL (a Terraform output and a GitHub
secret) held the site's publishing password. No live deployment used it.

## Decision

- `docker.yml` signs every pushed image with Sigstore cosign, keyless, by digest. GitHub's OIDC token proves which
  repo, workflow and ref built it; there is no signing key. Promote to stable runs `cosign verify` (identity: this
  repo's `docker.yml` on `main` or a `v*` tag) and refuses to move `stable` otherwise. There is no bypass: images up
  to 0.64.1.0 are unsigned and can no longer be promoted; the first signed version is the first promotable one.
- Continuous deployment uses GitHub OIDC instead of the webhook. With `continuous_deployment` the module makes a
  user-assigned identity with a federated credential for one GitHub subject, by default the repo's `stable`
  environment (an environment, not a branch: the owner can limit it to `main` and add reviewers, and a pull request
  never gets it). It gets a custom role on the web app with only `Microsoft.Web/sites/read` and
  `Microsoft.Web/sites/restart/action`, not Website Contributor, which can read the app settings (session secret,
  admin password). The workflow restarts each app in the `STABLE_DEPLOYMENTS` variable; App Service pulls the image
  again on restart. Basic authentication stays off and the scm site follows the site's access restrictions, always.
- `STABLE_DEPLOYMENTS` is a repository variable, not a secret: it holds IDs and names only, and access comes from
  each app's federated credential, which trusts only this repo's environment.

## Consequences

- Anyone can check an image with the `cosign verify` command in [SECURITY.md](../../SECURITY.md#check-the-image-signature);
  pinning a checked digest is the way to get a verified image without trusting a tag.
- No deploy password exists anywhere; the old `deploy_webhook_url` output and `STABLE_DEPLOY_WEBHOOKS` secret are gone
  (module v1.10.0, breaking for anyone who used them).
- Running Terraform with `continuous_deployment` needs Owner or User Access Administrator on the resource group,
  because it creates a custom role. Everything added is free.
- Renaming `docker.yml` or changing its triggers means updating the identity regexp in the promote workflow and the
  docs.
