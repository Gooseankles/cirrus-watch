// Microsoft's release feeds (Azure news, Microsoft 365 roadmap): HTML to plain text, the shape of each item, which
// items are kept, the Azure kind chips and the "in use" lookup from the Architecture resource list. Sample API
// payloads in, no network.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { stripHtml, ym, azureItem, azureKind, keepAzure, m365Item, keepM365, azureQueries, m365Queries, parseFeed } = require("../src/releaseFeeds")._test;
const { PRODUCT_TYPES, typesOf, ruleHit, productsInUse, inUseMap } = require("../src/tools/azureUpdates")._test;

after(env.cleanup);

const NOW = Date.parse("2026-11-01T06:00:00Z");
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

function azure(over) {
  return {
    id: "generally-available-thing",
    title: "Generally available: a thing",
    description: "<p>It&nbsp;works.</p>",
    products: ["App Service"],
    productCategories: ["Compute"],
    tags: ["Features"],
    status: "Launched",
    availabilities: [{ ring: "General Availability", year: 2026, month: "October" }],
    generalAvailabilityDate: "2026-10",
    previewAvailabilityDate: null,
    modified: ago(3),
    created: ago(10),
    ...over,
  };
}
function m365(over) {
  return { id: 412345, title: "Teams: a feature", description: "<div>Soon.</div>", products: ["Microsoft Teams"], platforms: ["Web"], cloudInstances: ["Worldwide (Standard Multi-Tenant)"], releaseRings: ["General Availability"], status: "In development", generalAvailabilityDate: "2027-01", previewAvailabilityDate: null, modified: ago(5), created: ago(90), ...over };
}

test("strips HTML to short plain text and decodes entities", () => {
  assert.equal(stripHtml("<p>One&nbsp;&amp; two</p><p>three &lt;b&gt; &#39;x&#39; &#x2013; y</p>"), "One & two three <b> 'x' – y");
  assert.equal(stripHtml('<script>alert(1)</script><style>p{}</style><a href="javascript:x" onclick="y">link</a>'), "link");
  assert.equal(stripHtml("<!-- hidden --><b>bold</b><br>next"), "bold next");
  assert.equal(stripHtml(null), "");
  const long = stripHtml(`<p>${"word ".repeat(200)}</p>`, 50);
  assert.ok(long.length <= 51, long);
  assert.ok(long.endsWith("…"));
  assert.equal(stripHtml("a <b broken"), "a b broken");
});

test("reads months from strings, names and numbers", () => {
  assert.equal(ym("2026-03"), "2026-03");
  assert.equal(ym("2026-03-15T00:00:00Z"), "2026-03");
  assert.equal(ym(2026, "March"), "2026-03");
  assert.equal(ym(2027, 11), "2027-11");
  assert.equal(ym(2026, "Smarch"), "");
  assert.equal(ym(null), "");
});

test("shapes an Azure update and drops one with a bad id", () => {
  const it = azureItem(azure({ availabilities: [{ ring: "Retirement", year: 2027, month: "March" }, { ring: "Preview", year: 2025, month: "June" }], tags: ["Retirements"] }));
  assert.equal(it.id, "generally-available-thing");
  assert.equal(it.summary, "It works.");
  assert.equal(it.retirement, "2027-03");
  assert.deepEqual(it.dates.map((d) => d.ym), ["2025-06", "2027-03"]);
  assert.equal(azureItem(azure({ id: "<script>" })), null);
  assert.equal(azureItem(azure({ title: "" })), null);
});

test("sorts Azure news into New & GA, Preview and Retiring", () => {
  assert.equal(azureKind(azureItem(azure())), "new");
  assert.equal(azureKind(azureItem(azure({ status: "In preview", availabilities: [{ ring: "Preview", year: 2026, month: "October" }], generalAvailabilityDate: null }))), "preview");
  assert.equal(azureKind(azureItem(azure({ status: null, tags: ["Retirements"], availabilities: [] }))), "retiring");
  assert.equal(azureKind(azureItem(azure({ status: null, tags: ["Features"], availabilities: [{ ring: "Retirement", year: 2028, month: "January" }] }))), "retiring");
  // A preview step before a GA date already reached is generally available now.
  assert.equal(azureKind(azureItem(azure({ status: null, availabilities: [{ ring: "Preview", year: 2026, month: "May" }], generalAvailabilityDate: "2026-09" }))), "new");
});

test("keeps recent Azure news and older ones with a date still ahead", () => {
  assert.equal(keepAzure(azureItem(azure({ modified: ago(30) })), NOW), true);
  assert.equal(keepAzure(azureItem(azure({ modified: ago(400), generalAvailabilityDate: "2024-01", availabilities: [] })), NOW), false);
  assert.equal(keepAzure(azureItem(azure({ modified: ago(400), generalAvailabilityDate: null, availabilities: [{ ring: "Retirement", year: 2027, month: "September" }] })), NOW), true);
  // This month still counts as ahead.
  assert.equal(keepAzure(azureItem(azure({ modified: ago(400), generalAvailabilityDate: "2026-11", availabilities: [] })), NOW), true);
});

test("keeps Microsoft 365 items in development, rolling out or launched lately", () => {
  assert.equal(keepM365(m365Item(m365()), NOW), true);
  assert.equal(keepM365(m365Item(m365({ status: "Rolling out", modified: ago(500) })), NOW), true);
  assert.equal(keepM365(m365Item(m365({ status: "Launched", modified: ago(20) })), NOW), true);
  assert.equal(keepM365(m365Item(m365({ status: "Launched", modified: ago(90) })), NOW), false);
  assert.equal(keepM365(m365Item(m365({ status: "Cancelled" })), NOW), false);
  assert.equal(m365Item(m365({ id: "12; drop" })), null);
  assert.deepEqual(m365Item(m365()).platforms, ["Web"]);
});

test("parses pages once per id, keeps and sorts newest first", () => {
  const pages = [
    { value: [azure({ id: "a", modified: ago(10) }), azure({ id: "b", modified: ago(2) }), azure({ id: "old", modified: ago(900), generalAvailabilityDate: "2023-01", availabilities: [] })] },
    { value: [azure({ id: "a", modified: ago(10) }), { id: "x" }] },
    null,
  ];
  const items = parseFeed("azure", pages, NOW);
  assert.deepEqual(items.map((i) => i.id), ["b", "a"]);
  assert.equal(items[0].kind, "new");
  assert.deepEqual(parseFeed("m365", [{ value: [m365({ id: 1 }), m365({ id: 2, status: "Launched", modified: ago(200) })] }], NOW).map((i) => i.id), [1]);
});

test("the requests carry dates only", () => {
  const [recent, ahead] = azureQueries(NOW);
  assert.equal(recent, "modified ge 2026-05-05T00:00:00Z");
  assert.match(ahead, /availabilities\/any\(a: a\/year ge 2026\)/);
  assert.match(m365Queries(NOW)[0], /status eq 'Launched' and modified ge 2026-09-02T00:00:00Z/);
});

test("marks updates in use from the Architecture resource list", () => {
  const resources = [
    { type: "microsoft.web/sites", kind: "functionapp,linux" },
    { type: "microsoft.storage/storageaccounts", kind: "StorageV2" },
    { type: "microsoft.dbforpostgresql/flexibleservers" },
  ];
  const present = typesOf(resources);
  assert.equal(ruleHit("microsoft.web/sites#functionapp", present), true);
  assert.equal(ruleHit("microsoft.web/sites#workflowapp", present), false);
  assert.equal(ruleHit("microsoft.dbforpostgresql/", present), true);
  assert.equal(ruleHit("microsoft.keyvault/vaults", present), false);
  assert.deepEqual(productsInUse(["Azure Functions", "Key Vault", "Azure Blob Storage", "Something new"], present), ["Azure Functions", "Azure Blob Storage"]);
  const items = [
    { id: "pg", products: ["Azure Database for PostgreSQL"] },
    { id: "kv", products: ["Key Vault"] },
    { id: "none", products: [] },
  ];
  assert.deepEqual(inUseMap(items, resources), { pg: ["Azure Database for PostgreSQL"] });
  assert.deepEqual(inUseMap(items, []), {});
  // Every rule is a lower-case type, a provider ending in "/" or "type#word".
  for (const [name, rules] of Object.entries(PRODUCT_TYPES)) {
    assert.equal(name, name.toLowerCase());
    for (const r of rules) assert.match(r, /^microsoft\.[a-z0-9]+\/([a-z0-9/]+(#[a-z]+)?)?$/, `${name}: ${r}`);
  }
});
