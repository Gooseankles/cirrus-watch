// The "How to fix" steps (public/fixes.js): every Azure Monitor finding kind has
// short steps and a Microsoft Learn page, so a new kind cannot ship without them.
const env = require("./_env");
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Fixes = require("../public/fixes.js");

after(env.cleanup);

const source = fs.readFileSync(path.join(__dirname, "..", "src", "tools", "azureMonitor.js"), "utf8");
const monitorKinds = [...new Set([...source.matchAll(/(?:kind: |f\(m, )"([a-z][a-z-]+)"/g)].map((m) => m[1]))];

test("the Azure Monitor kinds are found in the tool's source", () => {
  assert.ok(monitorKinds.length >= 17, `found only ${monitorKinds.length}: ${monitorKinds.join(", ")}`);
  for (const k of ["monitor-no-agent", "monitor-legacy-agent", "monitor-no-heartbeat", "workspace-over-quota"]) assert.ok(monitorKinds.includes(k), k);
});

test("every Azure Monitor kind has fix steps and a Microsoft Learn link", () => {
  for (const kind of monitorKinds) {
    const fix = Fixes.of(kind);
    assert.ok(fix, `${kind}: no entry in public/fixes.js`);
    assert.ok(fix.steps.length >= 3 && fix.steps.length <= 6, `${kind}: ${fix.steps.length} steps, want 3 to 6`);
    assert.match(fix.url, /^https:\/\/learn\.microsoft\.com\/en-us\/[\w/.-]+$/, `${kind}: ${fix.url}`);
  }
});

test("every entry is well formed", () => {
  for (const [kind, fix] of Object.entries(Fixes.KINDS)) {
    assert.ok(Array.isArray(fix.steps) && fix.steps.length, kind);
    for (const step of fix.steps) {
      assert.equal(typeof step, "string", kind);
      assert.ok(step.trim().length > 10 && step.length <= 320, `${kind}: step length ${step.length}`);
      assert.equal(step.split("`").length % 2, 1, `${kind}: unpaired backtick in "${step}"`);
    }
    assert.match(fix.url, /^https:\/\//, kind);
  }
});

test("of() returns null for unknown kinds and inherited names", () => {
  assert.equal(Fixes.of("nope"), null);
  assert.equal(Fixes.of("toString"), null);
  assert.equal(Fixes.of("__proto__"), null);
});

test("the No monitoring agent steps cover the portal, policy, CLI and prerequisites", () => {
  const text = Fixes.of("monitor-no-agent").steps.join(" ");
  for (const part of ["Data Collection Rules", "Add resources", "Insights", "Azure Policy", "remediation task", "az vm extension set", "Microsoft.Azure.Monitor", "AzureMonitorLinuxAgent", "az monitor data-collection rule association create", "managed identity", "443"]) {
    assert.ok(text.includes(part), part);
  }
});
