// The docs-to-wiki mirror (scripts/wiki-sync.mjs): page names, link rewriting, page bodies and the sidebar.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const wiki = () => import("../scripts/wiki-sync.mjs");
const REPO = "owner/repo";
const ADR3 = "ADR-0003-Secrets-typed-in-Settings-go-to-Key-Vault-never-into-Terraform";
const fakePages = () =>
  new Map(
    [
      ["README.md", "Home"],
      ["tools.md", "Scan-tools"],
      ["hld.md", "High-level-design"],
      ["guides/notifications.md", "Notifications"],
      ["adr/README.md", "Architecture-decision-records"],
      ["adr/0003-secrets.md", ADR3],
    ].map(([rel, name]) => [rel, { rel, name }]),
  );

test("page names: Home, decision records by number, every other page by its title", async () => {
  const { pageName } = await wiki();
  assert.equal(pageName("README.md", "Cirrus Watch documentation"), "Home");
  assert.equal(pageName("adr/0003-secrets.md", "0003. Secrets typed in Settings go to Key Vault, never into Terraform"), ADR3);
  assert.equal(pageName("adr/README.md", "Architecture decision records"), "Architecture-decision-records");
  assert.equal(pageName("lld-setup.md", "Setup low-level design"), "Setup-low-level-design");
  assert.equal(pageName("guides/azure-monitor-fixes.md", "Fixing Azure Monitor findings"), "Fixing-Azure-Monitor-findings");
  assert.equal(pageName("adr/0008-agpl-licence.md", "0008. AGPL-3.0-only for the app"), "ADR-0008-AGPL-3.0-only-for-the-app");
});

test("links: docs pages become wiki links, repository files GitHub addresses, pictures raw addresses", async () => {
  const { rewriteTarget } = await wiki();
  const pages = fakePages();
  assert.equal(rewriteTarget("tools.md#orphaned-resources", "README.md", pages, REPO), "Scan-tools#orphaned-resources");
  assert.equal(rewriteTarget("../tools.md", "guides/notifications.md", pages, REPO), "Scan-tools");
  assert.equal(rewriteTarget("0003-secrets.md", "adr/0001-x.md", pages, REPO), ADR3);
  assert.equal(rewriteTarget("../hld.md", "adr/0001-x.md", pages, REPO), "High-level-design");
  assert.equal(rewriteTarget("../CHANGELOG.md", "README.md", pages, REPO), "https://github.com/owner/repo/blob/main/CHANGELOG.md");
  assert.equal(rewriteTarget("../../SECURITY.md#check", "guides/notifications.md", pages, REPO), "https://github.com/owner/repo/blob/main/SECURITY.md#check");
  assert.equal(rewriteTarget("diagrams/arch-overview.png", "architecture.md", pages, REPO), "https://raw.githubusercontent.com/owner/repo/main/docs/diagrams/arch-overview.png");
  assert.equal(rewriteTarget("diagrams/arch-network.py", "architecture.md", pages, REPO), "https://github.com/owner/repo/blob/main/docs/diagrams/arch-network.py");
  for (const t of ["#anchor", "https://example.com/x", "mailto:a@example.com"]) assert.equal(rewriteTarget(t, "tools.md", pages, REPO), t);
  const warnings = [];
  rewriteTarget("../../../outside.md", "guides/notifications.md", pages, REPO, (w) => warnings.push(w));
  rewriteTarget("missing.md", "tools.md", pages, REPO, (w) => warnings.push(w));
  assert.equal(warnings.length, 2, "a link above the repository and a link to a missing file are both reported");
});

test("a page loses its title line, keeps code blocks as they are and gets its links rewritten", async () => {
  const { pageBody } = await wiki();
  const md = '# Scan tools\n\nSee [the design](hld.md "HLD") and ![pic](diagrams/a.png).\n\n```md\n[kept](hld.md)\n```\n\n## More\n';
  assert.equal(
    pageBody({ rel: "tools.md", md }, fakePages(), REPO),
    'See [the design](High-level-design "HLD") and ![pic](https://raw.githubusercontent.com/owner/repo/main/docs/diagrams/a.png).\n\n```md\n[kept](hld.md)\n```\n\n## More\n',
  );
  assert.equal(pageBody({ rel: "tools.md", md: "No title here.\n" }, fakePages(), REPO), "No title here.\n");
});

test("the sidebar follows the sections and bullets of docs/README.md, text only", async () => {
  const { sidebar } = await wiki();
  const home = "# Docs\n\nIntro [README](../README.md).\n\n## Using it\n\n- [Tools](tools.md): what every scan checks,\n  on two lines.\n\n## Building\n\n- [Design](hld.md).\n- [Changelog](../CHANGELOG.md).\n";
  assert.equal(
    sidebar(home, fakePages(), REPO),
    "**[Home](Home)**\n\n**Using it**\n\n- [Tools](Scan-tools)\n\n**Building**\n\n- [Design](High-level-design)\n- [Changelog](https://github.com/owner/repo/blob/main/CHANGELOG.md)\n",
  );
});

test("the real docs folder converts with every page link pointing at a wiki page and no warnings", async () => {
  const { collectPages, pageBody } = await wiki();
  const pages = collectPages();
  assert.ok(pages.size >= 20, `found ${pages.size} pages`);
  assert.equal(pages.get("README.md").name, "Home");
  const names = new Set([...pages.values()].map((p) => p.name));
  const warnings = [];
  for (const p of pages.values()) {
    const body = pageBody(p, pages, REPO, (w) => warnings.push(w));
    for (const [, t] of body.matchAll(/\]\(([^)\s]+)/g)) {
      if (/^(#|https?:|mailto:)/.test(t)) continue;
      assert.ok(names.has(t.split("#")[0]), `${p.rel}: link ${t} points at no wiki page`);
    }
  }
  assert.deepEqual(warnings, []);
});
