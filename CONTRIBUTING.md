# Contributing

Thanks for helping with Cirrus Watch. This page says how to run it locally, how to add a scan, what a change must
bring with it, and how the repository keeps itself up to date. How the app is built is in
[docs/architecture.md](docs/architecture.md); the main choices are in the [decision records](docs/adr/README.md).

## Run it locally

```sh
npm install
cp .env.example .env    # set DASHBOARD_ADMIN_PASSWORD at least
npm start               # http://localhost:7070, sign in as admin
```

Without Azure settings the app starts and every scan reports what it is missing. To scan a real tenant, fill in the
Azure connection in `.env` (a test service principal with the read permissions in
[docs/permissions.md](docs/permissions.md)) or on the Settings page.
Use Node.js 22 or newer; 26 is what the image is built on.

## Adding a tool

A scan tool is a file in `src/tools/` exporting `{ id, label, schedule, run() }`, where `run()` returns a list of
findings. An on-demand tool exports `{ id, label, registerRoutes(app) }` instead. Then:

1. Register it in `server.js` with `registerScanTool` (or `registerActionTool`).
2. Add it to the `TOOLS` list in `public/app.js`; each new finding kind gets a `KINDS` entry there and its controls
   in `public/compliance.js`; short "How to fix" steps with a Microsoft Learn link can go in `public/fixes.js`.
3. List what its identity needs in `src/toolPermissions.js` (`NEEDS`), give it an area in `src/access.js`
   (`TOOL_AREAS`) and an SPN override entry in `src/settings.js` (`TOOL_SPNS`). A tool that calls nothing in the
   tenant (`NEEDS` entry `{ none: true }`, such as Azure news) gets no `TOOL_SPNS` entry.
4. Add a `## <label>` section to [docs/tools.md](docs/tools.md) saying what it checks, and new access to
   [docs/permissions.md](docs/permissions.md).
5. Run `npm run docs`. It writes the README tools table, the tool count and the tool ids in `.env.example`, and
   fails when the tool is missing from any of the lists above.

When a new scan takes over older ones, keep the old finding kinds and ids, export `replaces: ["<old id>", ...]`
and remove the old tools from every list above. Stored results, trends and accepted findings move to the new id by
themselves the first time it is used in a tenant (see [architecture](docs/architecture.md#tool-contract)). Say in
the changelog's Upgrading section that per-tenant scan switches and per-tool identity overrides of the old ids must
be set again.

## What a change brings with it

**Every change is documented in the same commit**: anything added, changed or removed, however small. If it changes
the big picture (a new part, a new outside service, a new identity, a changed main choice) update the
[high-level design](docs/hld.md); if it changes what the Terraform setup creates or how start-up, sign-in or a scan
runs, update the [setup low-level design](docs/lld-setup.md). The pull request template has the checklist. In short:

- **Version:** bump `VERSION` (`major.minor.patch.build`) in the same commit as the change; see
  [ADR 0007](docs/adr/0007-versioning.md).
- **Changelog:** a line under the new version in [CHANGELOG.md](CHANGELOG.md) (Added, Changed, Fixed or Security),
  written for the person running the dashboard. If they must do something when upgrading, add it under
  **Upgrading** too.
- **Docs:** update the page for the reader it concerns ([docs/README.md](docs/README.md) lists them). The GitHub wiki
  is written from `docs/` by `scripts/wiki-sync.mjs` after every change on main, so edit the pages here, never in
  the wiki. A new setting
  goes in `.env.example` and the Settings hint; a new role, page or API route in
  [sign-in and roles](docs/guides/sign-in-and-roles.md) and [architecture.md](docs/architecture.md). A new big
  decision gets a decision record.
- **Diagrams:** the pictures in the docs are PNG files, so they show everywhere, also in GitHub's phone app. Their
  sources sit next to them in `docs/diagrams/` and come in two kinds: Mermaid text (`.mmd`) for sequences and step
  flows, and Python (`.py`, the [diagrams](https://diagrams.mingrammer.com) library, MIT) for the architecture
  pictures, which are drawn with the official
  [Microsoft Azure architecture icons](https://learn.microsoft.com/en-us/azure/architecture/icons/) the library
  ships. Microsoft permits those icons in architecture diagrams and documentation: use them as they are (never
  cropped, flipped, rotated or recoloured), with the product's name next to each, and never as an icon for the
  dashboard itself. Edit the source, run `npm run diagrams -- <name>` (needs Docker; the Python renderer is built
  from `docs/diagrams/Dockerfile` the first time), look at the PNG and commit both with
  `docs/diagrams/rendered.json`. A new picture is a new `.mmd` or `.py` (one of the two, never both; `_style.py`
  holds the shared look); embed the PNG with a `<sub>Source: ...</sub>` line under it as the others do. Keep them
  portrait (`flowchart TB`, `direction="TB"`) so they read on a phone.
- **Checks:** `npm test` (the unit tests in `test/`, node:test, no Azure needed; the image build waits for them),
  then `npm run docs:check` (it also fails when a `.mmd` or `.py` changed but its PNG was not rendered again), then Markdown style and links as the Docs workflow runs them:

  ```sh
  npx -y markdownlint-cli2@0.18.1 "**/*.md"
  docker run --rm -v "$PWD:/w" -w /w lycheeverse/lychee --no-progress --exclude-path docs/research README.md CONTRIBUTING.md 'docs/**/*.md'
  ```

- **Try it:** run it with `npm start` and open the pages you changed, on a phone width too.

Keep the code style of the file you are in: plain JavaScript, no build step, no inline scripts or styles in the
pages (the content security policy blocks them).

## How the repository stays up to date

- **Dependabot** (`.github/dependabot.yml`) opens weekly pull requests for npm packages (minor and patch grouped),
  the Node base image (not majors) and GitHub Actions (the CodeQL actions grouped, because `init` and `analyze`
  must be the same version). Each PR body has the release notes, and the image build with
  the Trivy gate runs on it before it is merged. Patch updates (and a new digest for the same Node image) merge by
  themselves once the build passes (`.github/workflows/dependabot-merge.yml`); minor and major updates wait for a
  person.
- **Pinned actions**: every `uses:` in `.github/workflows/` names a full commit SHA with its version as a comment,
  for example `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`; a tag can be moved, a SHA
  cannot. Dependabot (github-actions) updates the SHA and the comment together. To add an action, look up the SHA of
  the release tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (for an annotated tag, its `object.sha` is a
  tag object: follow it with `gh api repos/<owner>/<repo>/git/tags/<sha>`).
- **Weekly rebuild**: `docker.yml` also runs on Tuesdays, so the image picks up new Alpine and Node fixes and the
  merged updates, and the Trivy gate sees new CVEs. Promoting to `stable` stays a hand step.
- **Signed images**: every image `docker.yml` pushes is signed by digest with cosign, keyless (the job's
  `id-token: write` lets GitHub's OIDC token stand in for a signing key; nothing to store or rotate). The step then
  checks that every pushed tag names the signed digest. **Promote to stable** (`promote-stable.yml`, run by hand)
  runs `cosign verify` before it moves `stable` and stops when the signature is missing or comes from another
  workflow or ref, then restarts the apps listed in the `STABLE_DEPLOYMENTS` variable through GitHub OIDC (job in
  the `stable` environment; no deploy password). Keep the identity regexp in that workflow, in
  [SECURITY.md](SECURITY.md#check-the-image-signature) and in the module README the same if `docker.yml` is renamed
  or its triggers change.
- **CodeQL** (`.github/workflows/codeql.yml`) scans the JavaScript and the workflows on every push and weekly;
  findings go to the Security tab.
- **Every change is a pull request**: `main` takes no direct pushes, admins included. Work on a branch
  (`feature/...`, `fix/...`, `docs/...`), open a pull request and merge it with squash or rebase (merge commits are
  off, so the history stays linear); the branch is deleted on merge. Required checks: `build-and-push`,
  `analyze (javascript-typescript)`, `analyze (actions)`, `Generated docs match the code` and `Markdown style`. The
  branch must be up to date with `main` and every conversation resolved before the merge button works; no approval
  is required (one maintainer cannot approve their own work). Rename a job and the branch protection list must
  follow, or every pull request waits for a check that never comes. The settings are classic branch protection on
  `main`, read with `gh api repos/Gooseankles/cirrus-watch/branches/main/protection`.
- **Stack report** (`.github/workflows/stack-report.yml`, Mondays, or Run workflow by hand) checks every part the
  dashboard is built on, the version in use against the newest, with the release notes in between (breaking changes,
  deprecations and security fixes marked at the top of each). It keeps one open issue labelled `stack-report` up to
  date and closes it when everything is current. It also covers what Dependabot skips: a newer Node LTS major and the
  Trivy scanner pinned by digest (it gives the new digest). Run it locally with
  `GITHUB_TOKEN=$(gh auth token) node .github/scripts/stack-report.mjs` (writes `stack-report.md`).

## Licence

Cirrus Watch is AGPL-3.0-only ([ADR 0008](docs/adr/0008-agpl-licence.md)). By sending a change you agree that it is
shared under the same licence. Security problems go through [SECURITY.md](SECURITY.md), not an issue or a pull
request.
