# 0007. Four-part app version, semver for the module

- Status: accepted
- Date: 2026-10-23

## Context

Every push to `main` builds a Docker image, and admins need to pin and roll back to an exact image. The Terraform
module is used with `?ref=` and needs semver so a caller can tell a breaking change from a fix.

## Decision

The app has a four-part version `major.minor.patch.build` in the `VERSION` file (since 2026-10-20), bumped in the
same commit as the change; each build is pushed as that Docker tag and as `latest`, and `stable` is promoted by
hand. The module moved to its own repo on 2026-10-23 with semver tags `vX.Y.Z`. Both repos keep a changelog with an
Upgrading section.

## Consequences

- An image tag names exactly one build; roll back by setting the previous tag.
- `package.json` carries no version, so `VERSION` is the only source.
- The module tag and the image tag are separate pins: the first pins the infrastructure, the second the app.
