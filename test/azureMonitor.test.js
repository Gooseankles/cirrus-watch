// The Azure Monitor coverage counts at the top of its page: which machines count
// as monitored, the counts saved with the inventory and the sum over tenants.
// Plain data in, no Azure and no network.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { machineInventory, machineStatus, summaryOf, addSummaries } = require("../src/tools/azureMonitor")._test;

after(env.cleanup);

const NOW = Date.parse("2026-10-31T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

// A machine as the inventory saves it; by default a running VM that is fully monitored.
const m = (o = {}) => ({ kind: "VM", running: true, agent: "ama", agentState: "Succeeded", rules: ["dcr-1"], heartbeatChecked: true, lastHeartbeat: hoursAgo(0.5), ...o });

test("a machine is monitored with the agent, a rule and a recent heartbeat; else the first thing wrong", () => {
  const st = (o) => machineStatus(m(o), 2, NOW);
  assert.equal(st({}), "monitored");
  assert.equal(st({ agent: "none" }), "noAgent");
  assert.equal(st({ agent: "legacy", rules: [] }), "legacy");
  assert.equal(st({ agentState: "Failed" }), "agentFailed");
  assert.equal(st({ rules: [] }), "noDcr");
  assert.equal(st({ lastHeartbeat: hoursAgo(3) }), "noHeartbeat");
  assert.equal(st({ lastHeartbeat: null }), "noHeartbeat");
  // Heartbeat not read (workspace not reachable): judged by its setup.
  assert.equal(st({ heartbeatChecked: false, lastHeartbeat: null }), "monitored");
  // A stopped VM cannot send a heartbeat: judged by its setup.
  assert.equal(st({ running: false, lastHeartbeat: hoursAgo(100) }), "monitored");
  assert.equal(st({ kind: "Arc", running: false }), "disconnected");
});

test("summaryOf counts VMs, Arc servers, scale sets, alert rules and the setup", () => {
  const machines = [
    ...Array.from({ length: 58 }, () => m()),
    m({ agent: "none" }), m({ agent: "none" }), m({ agent: "none", running: false }),
    m({ agent: "legacy" }), m({ agent: "legacy" }),
    m({ lastHeartbeat: hoursAgo(30) }),
    m({ kind: "Arc" }), m({ kind: "Arc" }), m({ kind: "Arc", rules: [] }), m({ kind: "Arc", running: false }),
  ];
  const rules = [{ enabled: true }, { enabled: true }, { enabled: false }];
  const s = summaryOf({
    machines,
    rules,
    dcrs: [{}, {}],
    groups: [{}],
    workspaces: [{}, {}, {}],
    scaleSets: [{ agent: "ama", rules: 1 }, { agent: "ama", rules: 0 }, { agent: "none", rules: 0 }],
    hours: 2,
    now: NOW,
  });
  assert.deepEqual(s.vms, { total: 64, monitored: 58, running: 63, noAgent: 3, legacy: 2, agentFailed: 0, noDcr: 0, noHeartbeat: 1, disconnected: 0 });
  assert.deepEqual(s.arc, { total: 4, monitored: 2, running: 3, noAgent: 0, legacy: 0, agentFailed: 0, noDcr: 1, noHeartbeat: 0, disconnected: 1 });
  assert.deepEqual(s.scaleSets, { total: 3, monitored: 1, noAgent: 1, legacy: 0, noDcr: 1 });
  assert.deepEqual(s.alertRules, { total: 3, enabled: 2 });
  assert.equal(s.dataCollectionRules, 2);
  assert.equal(s.actionGroups, 1);
  assert.equal(s.workspaces, 3);
  // Every machine falls in exactly one bucket.
  const sum = (c) => c.monitored + c.noAgent + c.legacy + c.agentFailed + c.noDcr + c.noHeartbeat + c.disconnected;
  assert.equal(sum(s.vms), s.vms.total);
  assert.equal(sum(s.arc), s.arc.total);
});

test("a check that failed or a list not read gives unknown counts, not zeros", () => {
  const s = summaryOf({ machines: null, rules: [], hours: 2, now: NOW });
  assert.equal(s.vms, null);
  assert.equal(s.arc, null);
  assert.equal(s.scaleSets, null);
  assert.equal(s.dataCollectionRules, null);
  assert.deepEqual(s.alertRules, { total: 0, enabled: 0 });
});

test("counts from the inventory's own machine rows match the findings' view", () => {
  const sub = "/subscriptions/s1/resourceGroups/rg/providers";
  const inv = machineInventory({
    machines: [
      { id: `${sub}/Microsoft.Compute/virtualMachines/vm1`, name: "vm1", type: "microsoft.compute/virtualmachines", power: "PowerState/running" },
      { id: `${sub}/Microsoft.Compute/virtualMachines/vm2`, name: "vm2", type: "microsoft.compute/virtualmachines", power: "PowerState/running" },
      { id: `${sub}/Microsoft.HybridCompute/machines/arc1`, name: "arc1", type: "microsoft.hybridcompute/machines", arcStatus: "Connected" },
    ],
    exts: [
      { machineId: `${sub}/Microsoft.Compute/virtualMachines/vm1`, extType: "azuremonitorwindowsagent", state: "Succeeded" },
      { machineId: `${sub}/Microsoft.HybridCompute/machines/arc1`, extType: "microsoftmonitoringagent", state: "Succeeded" },
    ],
    dcras: [{ resourceId: `${sub}/Microsoft.Compute/virtualMachines/vm1`, ruleId: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Insights/dataCollectionRules/dcr1" }],
    dcrs: [{ id: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Insights/dataCollectionRules/dcr1", name: "dcr1", workspaces: [] }],
    heartbeats: new Map(),
    checked: new Set(),
  });
  const s = summaryOf({ machines: inv, rules: [], hours: 2, now: NOW });
  assert.equal(s.vms.total, 2);
  assert.equal(s.vms.monitored, 1);
  assert.equal(s.vms.noAgent, 1);
  assert.equal(s.arc.legacy, 1);
});

test("addSummaries adds tenants up; a count one tenant lacks is unknown in the total", () => {
  const a = summaryOf({ machines: [m(), m({ agent: "none" })], rules: [{ enabled: true }], dcrs: [{}], groups: [{}], workspaces: [{}], scaleSets: [], hours: 2, now: NOW });
  const b = summaryOf({ machines: [m()], rules: [{ enabled: false }], dcrs: [{}, {}], groups: [], workspaces: [{}], scaleSets: [], hours: 2, now: NOW });
  const old = summaryOf({ machines: [m({ kind: "Arc" })], rules: [], hours: 2, now: NOW }); // scan from before the counts
  const ab = addSummaries([a, b]);
  assert.equal(ab.vms.total, 3);
  assert.equal(ab.vms.monitored, 2);
  assert.equal(ab.vms.noAgent, 1);
  assert.deepEqual(ab.alertRules, { total: 2, enabled: 1 });
  assert.equal(ab.dataCollectionRules, 3);
  assert.equal(ab.actionGroups, 1);
  const all = addSummaries([a, b, old]);
  assert.equal(all.arc.total, 1);
  assert.equal(all.dataCollectionRules, null);
  assert.equal(all.scaleSets, null);
  assert.equal(addSummaries([]), null);
});
