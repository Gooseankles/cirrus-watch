// The Azure Monitor coverage counts at the top of its page: which machines count
// as monitored, whether an enabled log alert reads their data (alert coverage),
// the counts saved with the inventory and the sum over tenants.
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

/* ---------- alert coverage: does an enabled log alert read each machine's data? ---------- */

const { alertReach, machineFindings, ruleOf, alertWorkspacesSetting } = require("../src/tools/azureMonitor")._test;

const SUB = "/subscriptions/s1";
const WS = (n, sub = SUB) => `${sub}/resourceGroups/rg-mon/providers/Microsoft.OperationalInsights/workspaces/${n}`;
const DCR = (n) => `${SUB}/resourceGroups/rg-mon/providers/Microsoft.Insights/dataCollectionRules/${n}`;
const VM = (n, rg = "rg-app", sub = SUB) => `${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${n}`;
// A log search alert rule as Resource Graph returns it (2021-08-01 and later: properties.enabled, scopes, actions.actionGroups).
const logRule = (name, scopes, o = {}) => ruleOf({
  id: `${SUB}/resourceGroups/rg-mon/providers/microsoft.insights/scheduledqueryrules/${name}`,
  name,
  type: "microsoft.insights/scheduledqueryrules",
  kind: o.kind || "LogAlert",
  properties: { enabled: o.enabled !== false, scopes, severity: 2, actions: { actionGroups: ["/subscriptions/s1/resourceGroups/rg-mon/providers/microsoft.insights/actiongroups/ag-ops"] }, ...(o.types && { targetResourceTypes: o.types }) },
});
// Running VMs with the agent, each linked to one rule; dcrTo maps a rule name to its workspace.
function fleet(vms, dcrTo, reach) {
  return machineInventory({
    machines: vms.map(([id]) => ({ id, name: id.split("/").pop(), type: "microsoft.compute/virtualmachines", power: "PowerState/running", resourceGroup: id.split("/")[4], subscriptionId: id.split("/")[2] })),
    exts: vms.map(([id]) => ({ machineId: id, extType: "azuremonitorlinuxagent", state: "Succeeded" })),
    dcras: vms.filter(([, dcr]) => dcr).map(([id, dcr]) => ({ resourceId: id, ruleId: DCR(dcr) })),
    dcrs: Object.entries(dcrTo).map(([n, ws]) => ({ id: DCR(n), name: n, workspaces: ws ? [ws] : [] })),
    heartbeats: new Map(),
    checked: new Set(),
    reach,
  });
}
const byName = (inv) => Object.fromEntries(inv.map((x) => [x.name, x]));

test("a workspace-scoped log alert covers the machines that send to that workspace, case-insensitively", () => {
  const reach = alertReach([logRule("cpu-high", [WS("LAW-Prod-Alerts").toUpperCase()])]);
  assert.equal(reach.source, "rules");
  const inv = byName(fleet([[VM("vm1"), "dcr-prod"], [VM("vm2"), "dcr-dev"]], { "dcr-prod": WS("law-prod-alerts"), "dcr-dev": WS("law-dev") }, reach));
  assert.equal(inv.vm1.alert, "workspace");
  assert.deepEqual(inv.vm1.alertWorkspaces, ["law-prod-alerts"]);
  assert.equal(inv.vm2.alert, "none");
  const found = machineFindings(Object.values(inv), { hours: 2, reach });
  assert.deepEqual(found.map((f) => [f.kind, f.name]), [["monitor-not-alerted", "vm2"]]);
  assert.equal(found[0].detail, "Sends data to law-dev, but no enabled log alert rule reads that workspace: no log search alert can fire on its logs");
  assert.equal(found[0].id, `${VM("vm2")}#monitor`);
});

test("rules scoped to a subscription, resource group or the machine itself cover it whatever the workspace", () => {
  const dcrTo = { "dcr-dev": WS("law-dev") };
  const vms = [[VM("vm1", "rg-app"), "dcr-dev"], [VM("vm2", "rg-web"), "dcr-dev"], [VM("vm3", "rg-web", "/subscriptions/s2"), "dcr-dev"], [VM("vm4", "rg-data", "/subscriptions/s3"), "dcr-dev"]];
  const reach = alertReach([
    logRule("rg", ["/subscriptions/S1/resourceGroups/RG-APP"]),
    logRule("sub", ["/subscriptions/s2/"]),
    logRule("one", [VM("vm4", "rg-data", "/subscriptions/s3").toLowerCase()]),
  ]);
  const inv = byName(fleet(vms, dcrTo, reach));
  assert.equal(inv.vm1.alert, "scope");
  assert.equal(inv.vm2.alert, "none"); // another resource group
  assert.equal(inv.vm3.alert, "scope");
  assert.equal(inv.vm4.alert, "scope");
  // A resource group name that only starts the same is not the same group.
  assert.equal(alertReach([logRule("rg", [`${SUB}/resourceGroups/rg`])]).coversResource(VM("vm1", "rg-app"), "microsoft.compute/virtualmachines"), false);
  // Target resource types narrow a subscription-wide rule.
  const sql = alertReach([logRule("sql", ["/subscriptions/s2"], { types: ["Microsoft.Sql/servers"] })]);
  assert.equal(sql.coversResource(VM("vm3", "rg-web", "/subscriptions/s2"), "microsoft.compute/virtualmachines"), false);
  const vmsOnly = alertReach([logRule("vms", ["/subscriptions/s2"], { types: ["Microsoft.Compute/virtualMachines"] })]);
  assert.equal(vmsOnly.coversResource(VM("vm3", "rg-web", "/subscriptions/s2"), "microsoft.compute/virtualmachines"), true);
});

test("disabled log rules, other rule kinds and log-to-metric rules do not count", () => {
  const metric = { kind: "Metric", enabled: true, scopes: [WS("law-prod-alerts")], actionGroups: [] };
  const reach = alertReach([logRule("off", [WS("law-prod-alerts")], { enabled: false }), logRule("l2m", [WS("law-prod-alerts")], { kind: "LogToMetric" }), metric]);
  assert.equal(reach.source, null);
  assert.equal(reach.logRules, 0);
  assert.equal(reach.readsWorkspace(WS("law-prod-alerts")), false);
  // A legacy rule (2018-04-16: enabled "false", source.dataSourceId) is read the same way.
  const legacy = ruleOf({ id: "x", name: "legacy", type: "microsoft.insights/scheduledqueryrules", properties: { enabled: "false", source: { dataSourceId: WS("law-old") } } });
  assert.equal(legacy.enabled, false);
  assert.deepEqual(legacy.scopes, [WS("law-old")]);
});

test("the setting names the alerting workspaces (IDs or names) instead of the rules' workspaces", () => {
  const rules = [logRule("cpu", [WS("law-prod-alerts")]), logRule("rg", [`${SUB}/resourceGroups/rg-app`])];
  const reach = alertReach(rules, ` LAW-Central , ${WS("law-sec", "/subscriptions/s9").toUpperCase()}/ `);
  assert.equal(reach.source, "setting");
  assert.deepEqual(reach.workspaces.sort(), ["law-central", "law-sec"]);
  const inv = byName(fleet(
    [[VM("vm1", "rg-web"), "a"], [VM("vm2", "rg-web"), "b"], [VM("vm3", "rg-web"), "c"], [VM("vm4", "rg-app"), "c"]],
    { a: WS("law-central", "/subscriptions/s5"), b: WS("law-sec", "/subscriptions/s9"), c: WS("law-prod-alerts") },
    reach,
  ));
  assert.equal(inv.vm1.alert, "workspace"); // by name, any subscription
  assert.equal(inv.vm2.alert, "workspace"); // by resource ID
  assert.equal(inv.vm3.alert, "none"); // the rule's own workspace is replaced by the setting
  assert.equal(inv.vm4.alert, "scope"); // resource-scoped rules still count
  // A resource ID pasted without its leading slash is still an ID, not a name that never matches.
  const pasted = alertReach(rules, WS("law-sec", "/subscriptions/s9").slice(1));
  assert.equal(pasted.readsWorkspace(WS("law-sec", "/subscriptions/s9")), true);
  assert.equal(pasted.readsWorkspace(WS("law-sec", "/subscriptions/s1")), false);
  // Blank setting: back to the rules; the setting is read per tenant through settings.get.
  assert.equal(alertReach(rules, "  ").source, "rules");
  process.env.AZURE_MONITOR_ALERT_WORKSPACES = "law-central";
  try {
    assert.equal(alertWorkspacesSetting(), "law-central");
  } finally {
    delete process.env.AZURE_MONITOR_ALERT_WORKSPACES;
  }
});

test("a tenant with no log alert rule gets one finding, not one per machine", () => {
  const reach = alertReach([]);
  const inv = fleet([[VM("vm1"), "a"], [VM("vm2"), "a"], [VM("vm3"), "b"], [VM("vm4"), null]], { a: WS("law-prod"), b: WS("law-dev") }, reach);
  const found = machineFindings(inv, { hours: 2, reach });
  const notAlerted = found.filter((f) => f.kind === "monitor-not-alerted");
  assert.equal(notAlerted.length, 1);
  assert.equal(notAlerted[0].id, "azure-monitor/log-alerts");
  assert.equal(notAlerted[0].subscriptionId, null);
  assert.match(notAlerted[0].detail, /^No enabled log alert rule in this tenant: no log search alert can fire for the 3 running machines that send data to law-prod, law-dev$/);
  // vm4 has no rule: its own finding, and it is not counted as not alerted.
  assert.deepEqual(found.filter((f) => f.kind !== "monitor-not-alerted").map((f) => [f.kind, f.name]), [["monitor-no-dcr", "vm4"]]);
});

test("only machines that send data are judged, and the summary counts alert coverage", () => {
  const reach = alertReach([logRule("cpu", [WS("law-prod-alerts")]), logRule("rg", [`${SUB}/resourceGroups/rg-web`])]);
  const inv = fleet(
    [[VM("vm1"), "p"], [VM("vm2"), "p"], [VM("vm3"), "d"], [VM("vm4", "rg-web"), "d"], [VM("vm5"), null], [VM("vm6"), "m"]],
    { p: WS("law-prod-alerts"), d: WS("law-dev"), m: null },
    reach,
  );
  const by = byName(inv);
  assert.equal(by.vm5.alert, null); // no collection rule
  assert.equal(by.vm6.alert, null); // a rule with no workspace destination (metrics only)
  const s = summaryOf({ machines: inv, rules: [], hours: 2, now: NOW });
  assert.deepEqual(s.alertCoverage, { total: 6, covered: 3, byWorkspace: 2, byScope: 1, notAlerted: 1, noData: 2 });
  // Without reach (an older scan) the machines are not judged and the count is unknown.
  assert.equal(fleet([[VM("vm1"), "p"]], { p: WS("law-prod-alerts") }, null)[0].alert, null);
  assert.equal(summaryOf({ machines: [m()], rules: [], hours: 2, now: NOW }).alertCoverage, null);
  // Added up over tenants; a tenant from before the count makes the total unknown.
  const a = summaryOf({ machines: inv, rules: [], hours: 2, now: NOW });
  assert.equal(addSummaries([a, a]).alertCoverage.covered, 6);
  assert.equal(addSummaries([a, summaryOf({ machines: [m()], rules: [], hours: 2, now: NOW })]).alertCoverage, null);
});

test("Uses Azure Monitor: auto by default and for unknown values; on and off as set", () => {
  const { mode } = require("../src/tools/azureMonitor")._test;
  const before = process.env.AZURE_MONITOR_IN_USE;
  try {
    delete process.env.AZURE_MONITOR_IN_USE;
    assert.equal(mode(), "auto");
    for (const [v, want] of [["on", "on"], ["OFF", "off"], ["auto", "auto"], ["maybe", "auto"]]) {
      process.env.AZURE_MONITOR_IN_USE = v;
      assert.equal(mode(), want, v);
    }
  } finally {
    if (before === undefined) delete process.env.AZURE_MONITOR_IN_USE;
    else process.env.AZURE_MONITOR_IN_USE = before;
  }
});
