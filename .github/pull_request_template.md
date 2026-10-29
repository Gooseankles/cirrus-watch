<!-- markdownlint-disable-file MD041 -->
## What and why

<!-- One or two lines: what changes for the person using Cirrus Watch, and why. -->

## Done means

- [ ] `VERSION` bumped in this commit (major.minor.patch.build)
- [ ] `CHANGELOG.md` has a line under the new version (and under **Upgrading** if someone must act)
- [ ] `npm run docs` run, and its changes committed (the Docs check fails otherwise)
- [ ] New or changed scan: `docs/tools.md` section, Settings fields, `docs/permissions.md` if it needs new access
- [ ] New setting: `.env.example` and the Settings page hint say what blank means
- [ ] New role, page or API route: README "Signing in and roles" and `docs/architecture.md`
- [ ] Tried it locally (`npm start`) or on the test server
