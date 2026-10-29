<!-- markdownlint-disable-file MD041 -->
## What and why

<!-- One or two lines: what changes for the person using Cirrus Watch, and why. -->

## Done means

- [ ] `VERSION` bumped in this commit (major.minor.patch.build)
- [ ] `CHANGELOG.md` has a line under the new version (and under **Upgrading** if someone must act)
- [ ] Documented: every added, changed or removed behaviour is in the docs page for its reader ([docs/README.md](../docs/README.md))
- [ ] `docs/hld.md` updated if the big picture changed; `docs/lld-setup.md` if the setup, start-up, sign-in or a scan run changed
- [ ] `npm run docs` run, and its changes committed (the Docs check fails otherwise)
- [ ] New or changed scan: `docs/tools.md` section, Settings fields, `docs/permissions.md` if it needs new access
- [ ] New setting: `.env.example` and the Settings page hint say what blank means
- [ ] New role, page or API route: `docs/guides/sign-in-and-roles.md` and `docs/architecture.md`
- [ ] Tried it locally (`npm start`) or on the test server
