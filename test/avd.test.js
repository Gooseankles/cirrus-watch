// The Azure Virtual Desktop scan: session host states, host pool checks and
// application group / workspace links, from sample ARM and Resource Graph
// payloads. Plain data in, no Azure and no network.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { poolOf, hostOf, scalingByPool, hostFindings, poolFindings, linkFindings, inventoryOf } = require("../src/tools/avd")._test;

after(env.cleanup);

const RG = "/subscriptions/s1/resourceGroups/rg-avd/providers/Microsoft.DesktopVirtualization";
const NOW = Date.parse("2026-10-31T12:00:00Z");
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

const pooled = poolOf({ id: `${RG}/hostPools/hp-pooled`, name: "hp-pooled", resourceGroup: "rg-avd", subscriptionId: "s1", properties: { hostPoolType: "Pooled", startVMOnConnect: false } });
const personal = poolOf({ id: `${RG}/hostPools/hp-personal`, name: "hp-personal", resourceGroup: "rg-avd", subscriptionId: "s1", properties: { hostPoolType: "Personal", personalDesktopAssignmentType: "Automatic" } });
const empty = poolOf({ id: `${RG}/hostPools/hp-empty`, name: "hp-empty", resourceGroup: "rg-avd", subscriptionId: "s1", properties: { hostPoolType: "Pooled" } });

// One ARM session host as the list call returns it.
function host(pool, name, props) {
  return hostOf({ id: `${pool.id}/sessionHosts/${name}`, name: `${pool.name}/${name}`, properties: { status: "Available", allowNewSession: true, lastHeartBeat: ago(0), sessions: 0, ...props } }, pool);
}

test("shapes host pools and session hosts from the API payloads", () => {
  assert.equal(pooled.type, "Pooled");
  assert.equal(personal.assignment, "Automatic");
  assert.equal(personal.startOnConnect, false);
  const h = host(pooled, "vm1.contoso.com", {
    status: "Unavailable",
    sessionHostHealthCheckResults: [
      { healthCheckName: "DomainJoinedCheck", healthCheckResult: "HealthCheckSucceeded" },
      { healthCheckName: "FSLogixHealthCheck", healthCheckResult: "HealthCheckFailed", additionalFailureDetails: { message: "Profile container did not mount" } },
    ],
  });
  assert.equal(h.name, "vm1.contoso.com");
  assert.equal(h.pool, "hp-pooled");
  assert.deepEqual(h.failedChecks, ["FSLogixHealthCheck: Profile container did not mount"]);
});

test("scaling plans are matched to host pools, an enabled reference wins", () => {
  const map = scalingByPool([
    { name: "sp-off", properties: { hostPoolReferences: [{ hostPoolArmPath: pooled.id, scalingPlanEnabled: false }] } },
    { name: "sp-on", properties: { hostPoolReferences: [{ hostPoolArmPath: pooled.id.toUpperCase(), scalingPlanEnabled: true }] } },
    { name: "sp-none", properties: {} },
  ]);
  assert.deepEqual(map.get(pooled.id.toLowerCase()), { plan: "sp-on", enabled: true });
  assert.equal(map.size, 1);
});

test("session hosts: down, not ready, shut down, failed agent update and forgotten in drain mode", () => {
  const pools = new Map([
    [pooled.id.toLowerCase(), { ...pooled, scaling: null }],
    [personal.id.toLowerCase(), { ...personal, scaling: null, startOnConnect: true }],
  ]);
  const hosts = [
    host(pooled, "ok", {}),
    host(pooled, "down", { status: "Unavailable", sessionHostHealthCheckResults: [{ healthCheckName: "SxSStackListenerCheck", healthCheckResult: "HealthCheckFailed" }] }),
    host(pooled, "help", { status: "NeedsAssistance" }),
    host(pooled, "nobeat", { status: "NoHeartbeat" }),
    host(pooled, "off", { status: "Shutdown" }),
    host(personal, "off-but-starts", { status: "Shutdown", assignedUser: "a@contoso.com" }),
    host(pooled, "upgrading", { status: "Upgrading" }),
    host(pooled, "agent", { updateState: "Failed", updateErrorMessage: "Download failed", agentVersion: "1.0.9000" }),
    host(pooled, "drained-dead", { allowNewSession: false, status: "Unavailable", lastHeartBeat: ago(20) }),
    host(pooled, "drained-alive", { allowNewSession: false, lastHeartBeat: ago(1) }),
    host(pooled, "drained-never", { allowNewSession: false, lastHeartBeat: null }),
  ];
  const out = hostFindings(hosts, pools, NOW);
  const kinds = (name) => out.filter((f) => f.name === name).map((f) => f.kind).sort();
  assert.deepEqual(kinds("ok"), []);
  assert.deepEqual(kinds("down"), ["avd-host-unavailable"]);
  assert.match(out.find((f) => f.name === "down").detail, /SxSStackListenerCheck/);
  assert.deepEqual(kinds("help"), ["avd-host-unavailable"]);
  assert.deepEqual(kinds("nobeat"), ["avd-host-not-ready"]);
  assert.deepEqual(kinds("off"), ["avd-host-shutdown"]);
  assert.deepEqual(kinds("off-but-starts"), [], "Start VM on Connect starts it");
  assert.deepEqual(kinds("upgrading"), []);
  assert.deepEqual(kinds("agent"), ["avd-agent-update-failed"]);
  assert.match(out.find((f) => f.name === "agent").detail, /Download failed/);
  assert.deepEqual(kinds("drained-dead"), ["avd-host-drain-forgotten"], "a drained host is not reported as down");
  assert.deepEqual(kinds("drained-alive"), []);
  assert.deepEqual(kinds("drained-never"), ["avd-host-drain-forgotten"]);
  // Ids are stable and distinct per check on the same host.
  const ids = out.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(`${pooled.id}/sessionHosts/agent#avd/agent`));
});

test("a shut-down host in a pool with an enabled scaling plan is left alone", () => {
  const pools = new Map([[pooled.id.toLowerCase(), { ...pooled, scaling: { plan: "sp", enabled: true } }]]);
  assert.deepEqual(hostFindings([host(pooled, "off", { status: "Shutdown" })], pools, NOW), []);
  const offPlan = new Map([[pooled.id.toLowerCase(), { ...pooled, scaling: { plan: "sp", enabled: false } }]]);
  assert.equal(hostFindings([host(pooled, "off", { status: "Shutdown" })], offPlan, NOW).length, 1);
});

test("host pools: empty, pooled with no scaling plan, unassigned personal desktops, no Start VM on Connect", () => {
  const pools = [
    { ...pooled, scaling: null, checked: true, hosts: [host(pooled, "a", {})] },
    { ...personal, scaling: null, checked: true, hosts: [host(personal, "p1", { assignedUser: "a@contoso.com" }), host(personal, "p2", {}), host(personal, "p3", {})] },
    { ...empty, scaling: { plan: "sp", enabled: true }, checked: true, hosts: [] },
    { ...poolOf({ id: `${RG}/hostPools/hp-failed`, name: "hp-failed", properties: { hostPoolType: "Pooled" } }), scaling: { plan: "sp", enabled: true }, checked: false, hosts: [] },
  ];
  const out = poolFindings(pools);
  const by = (name) => out.filter((f) => f.name === name).map((f) => f.kind).sort();
  assert.deepEqual(by("hp-pooled"), ["avd-pool-no-scaling"]);
  assert.deepEqual(by("hp-personal"), ["avd-no-start-on-connect", "avd-personal-unassigned"]);
  assert.match(out.find((f) => f.kind === "avd-personal-unassigned").detail, /^2 personal desktops of 3/);
  assert.deepEqual(by("hp-empty"), ["avd-pool-empty"]);
  assert.deepEqual(by("hp-failed"), [], "a pool whose hosts could not be read is not called empty");
});

test("application groups in no workspace and empty workspaces", () => {
  const groups = [
    { id: `${RG}/applicationGroups/ag-shown`, name: "ag-shown", properties: { applicationGroupType: "Desktop", hostPoolArmPath: pooled.id } },
    { id: `${RG}/applicationGroups/ag-lost`, name: "ag-lost", properties: { applicationGroupType: "RemoteApp", hostPoolArmPath: pooled.id } },
    { id: `${RG}/applicationGroups/ag-other-sub`, name: "ag-other-sub", properties: { applicationGroupType: "Desktop", hostPoolArmPath: personal.id, workspaceArmPath: "/subscriptions/s9/resourceGroups/x/providers/Microsoft.DesktopVirtualization/workspaces/ws9" } },
  ];
  const workspaces = [
    { id: `${RG}/workspaces/ws1`, name: "ws1", properties: { applicationGroupReferences: [`${RG}/applicationgroups/AG-SHOWN`] } },
    { id: `${RG}/workspaces/ws-empty`, name: "ws-empty", properties: { applicationGroupReferences: [] } },
  ];
  const out = linkFindings(groups, workspaces);
  assert.deepEqual(out.map((f) => `${f.kind} ${f.name}`).sort(), ["avd-appgroup-no-workspace ag-lost", "avd-workspace-empty ws-empty"]);
  assert.equal(out.find((f) => f.name === "ag-lost").hostPool, "hp-pooled");

  const inv = inventoryOf([{ ...pooled, scaling: { plan: "sp", enabled: false }, checked: true, hosts: [host(pooled, "a", { sessions: 3 }), host(pooled, "b", { status: "Unavailable", allowNewSession: false })] }], groups, workspaces);
  assert.equal(inv[0].hosts, 2);
  assert.equal(inv[0].available, 1);
  assert.equal(inv[0].draining, 1);
  assert.equal(inv[0].sessions, 3);
  assert.equal(inv[0].scalingPlan, "sp (off)");
  assert.deepEqual(inv[0].appGroups, ["ag-shown", "ag-lost"]);
  assert.deepEqual(inv[0].workspaces, ["ws1"]);
});
