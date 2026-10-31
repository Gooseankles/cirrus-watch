// Security checks on the Azure side: classic administrators, Defender plan details, security contacts and open
// alerts, storage hardening, workspace retention, subnets without an NSG and the default delete-lock types.
// Plain data in, no Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const subs = require("../src/tools/subscriptions")._test;
const defender = require("../src/tools/defender")._test;
const storage = require("../src/tools/resourceSettings")._test;
const diag = require("../src/tools/diagnosticSettings")._test;
const net = require("../src/tools/networkHygiene")._test;
const { DEFAULT_LOCK_TYPES } = require("../src/tools/safetyNets");

after(env.cleanup);

const DAY = 86400000;
const NOW = Date.parse("2026-10-31T12:00:00Z");

test("every classic administrator is a finding; refused reads make one quiet note", () => {
  const read = [
    {
      subscriptionId: "s1",
      name: "Prod",
      admins: [
        { name: "a", properties: { emailAddress: "Owner@contoso.com", role: "ServiceAdministrator;AccountAdministrator" } },
        { name: "b", properties: { emailAddress: "old@contoso.com", role: "CoAdministrator" } },
      ],
    },
    { subscriptionId: "s2", name: "Dev", admins: [] },
  ];
  const found = subs.judgeClassicAdmins(read, [{ subscriptionId: "s3", name: "Locked" }]);
  const admins = found.filter((f) => f.kind === "classic-admin");
  assert.deepEqual(admins.map((f) => [f.name, f.role, f.subscriptionId]), [
    ["Owner@contoso.com", "Service Administrator", "s1"],
    ["old@contoso.com", "Co-Administrator", "s1"],
  ]);
  assert.equal(new Set(admins.map((f) => f.id)).size, 2);
  const note = found.filter((f) => f.kind === "classic-admin-unread");
  assert.equal(note.length, 1);
  assert.match(note[0].detail, /Locked/);
  assert.match(admins[0].detail, /December 2025 Azure gave the remaining ones an Owner role assignment/);
  assert.deepEqual(subs.judgeClassicAdmins([{ subscriptionId: "s2", admins: [] }]), []);
});

test("Servers Plan 1 is flagged only when another subscription has Plan 2; agentless off only where included", () => {
  const off = [{ name: "AgentlessVmScanning", isEnabled: "False" }];
  const tiers = [
    { subscriptionId: "s1", plan: "VirtualMachines", on: true, subPlan: "P2", extensions: [{ name: "AgentlessVmScanning", isEnabled: "True" }] },
    { subscriptionId: "s2", plan: "VirtualMachines", on: true, subPlan: "P1", extensions: [] },
    { subscriptionId: "s3", plan: "VirtualMachines", on: true, subPlan: "P2", extensions: off },
    { subscriptionId: "s3", plan: "CloudPosture", on: true, subPlan: "", extensions: off },
    { subscriptionId: "s4", plan: "CloudPosture", on: false, subPlan: "", extensions: off },
    { subscriptionId: "s4", plan: "StorageAccounts", on: true, subPlan: "DefenderForStorageV2", extensions: off },
  ];
  const found = defender.judgePlanDetails(tiers);
  assert.deepEqual(found.map((f) => [f.kind, f.subscriptionId]), [
    ["defender-servers-p1", "s2"],
    ["defender-agentless-off", "s3"],
    ["defender-agentless-off", "s3"],
  ]);
  assert.equal(new Set(found.map((f) => f.id)).size, 3);
  assert.match(found[0].detail, /premium vulnerability management/);
  assert.doesNotMatch(found[0].detail, /no .*vulnerability assessment/, "Plan 1 still has Defender for Endpoint's assessment");
  // All on Plan 1: nothing to compare against.
  assert.deepEqual(defender.judgePlanDetails([{ subscriptionId: "s1", plan: "VirtualMachines", on: true, subPlan: "P1" }]), []);
});

test("security contacts: nobody told, alert e-mails off, or only roles told", () => {
  const contact = (props) => ({ properties: { isEnabled: true, notificationsSources: [{ sourceType: "Alert", minimalSeverity: "High" }], ...props } });
  const list = [
    { subscriptionId: "ok", contacts: [contact({ emails: "secops@contoso.com" })] },
    { subscriptionId: "none", contacts: [] },
    { subscriptionId: "disabled", contacts: [contact({ emails: "a@b.c", isEnabled: false })] },
    { subscriptionId: "empty", contacts: [contact({ emails: "", notificationsByRole: { state: "Off", roles: ["Owner"] } })] },
    { subscriptionId: "mailoff", contacts: [contact({ emails: "a@b.c", notificationsSources: [{ sourceType: "AttackPath", minimalRiskLevel: "Critical" }] })] },
    { subscriptionId: "roles", contacts: [contact({ emails: " ; ", notificationsByRole: { state: "On", roles: ["Owner"] } })] },
  ];
  const found = defender.judgeContacts(list);
  assert.deepEqual(found.map((f) => [f.subscriptionId, f.kind]), [
    ["none", "defender-no-contact"],
    ["disabled", "defender-no-contact"],
    ["empty", "defender-no-contact"],
    ["mailoff", "defender-alert-mail-off"],
    ["roles", "defender-contact-no-email"],
  ]);
});

test("open alerts: High first, then oldest; one row per group with count and age; capped", () => {
  const rows = [
    { subscriptionId: "s1", alertType: "VM_Medium", sev: "Medium", hits: 3, oldest: new Date(NOW - 40 * DAY).toISOString(), alertName: "Suspicious process" },
    { subscriptionId: "s1", alertType: "VM_High", sev: "High", hits: 1, oldest: new Date(NOW - 2 * DAY).toISOString(), entity: "vm-web-01" },
    { subscriptionId: "s2", alertType: "Storage_High", sev: "high", hits: 2, oldest: new Date(NOW - 10 * DAY).toISOString() },
  ];
  const found = defender.judgeAlerts(rows, NOW);
  assert.deepEqual(found.map((f) => [f.kind, f.subscriptionId, f.alerts, f.ageDays]), [
    ["defender-alert-high", "s2", 2, 10],
    ["defender-alert-high", "s1", 1, 2],
    ["defender-alert-medium", "s1", 3, 40],
  ]);
  assert.match(found[1].detail, /vm-web-01/);
  const many = Array.from({ length: 205 }, (_, i) => ({ subscriptionId: "s1", alertType: `T${i}`, sev: "Medium", hits: 1, oldest: new Date(NOW).toISOString() }));
  const capped = defender.judgeAlerts(many, NOW);
  assert.equal(capped.filter((f) => f.kind === "defender-alert-medium").length, 200);
  assert.equal(capped.length, 201); // plus the note that some were left out
});

test("storage extras: cross-tenant replication only when on; SAS policy and Entra default ride along in the keys finding", () => {
  const acct = (name, o) => ({ id: `/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/${name}`, name, https: true, network: "Disabled", ...o });
  const judge = (o) => storage.judgeStorage([acct("a", o)]).filter((f) => !["cfg-storage-http", "cfg-storage-no-firewall"].includes(f.kind));
  const kinds = (o) => judge(o).map((f) => f.kind);
  assert.deepEqual(kinds({ sharedKey: false, crossTenant: null }), []);
  assert.deepEqual(kinds({ sharedKey: false, crossTenant: true }), ["cfg-storage-cross-tenant-replication"]);
  assert.deepEqual(kinds({ sharedKey: true, crossTenant: false }), ["cfg-storage-keys"]);
  const keys = judge({ sharedKey: true, crossTenant: false })[0];
  assert.match(keys.detail, /Meanwhile: no SAS expiration policy.*; the portal opens data with the key/);
  const policy = judge({ sharedKey: null, sasPolicy: { sasExpirationPeriod: "1.00:00:00", expirationAction: "Log" }, oauthDefault: true });
  assert.deepEqual(policy.map((f) => f.kind), ["cfg-storage-keys"]);
  assert.doesNotMatch(policy[0].detail, /Meanwhile/);
  assert.match(judge({ sharedKey: true, oauthDefault: true }).find((f) => f.kind === "cfg-storage-keys").detail, /Meanwhile: no SAS expiration policy[^;]*$/);
  const f = storage.judgeStorage([acct("b", { sharedKey: false, crossTenant: "true" })]).find((x) => x.kind === "cfg-storage-cross-tenant-replication");
  assert.equal(f.rule, null); // no PSRule rule, so no "How to fix" link
});

test("workspaces keeping logs under 90 days are flagged", () => {
  const ws = (name, retention) => ({ id: `/subscriptions/s1/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/${name}`, name, resourceGroup: "rg", subscriptionId: "s1", retention });
  const found = diag.judgeRetention([ws("short", 30), ws("ok", 90), ws("long", 730), ws("unknown", null)]);
  assert.deepEqual(found.map((f) => [f.name, f.kind, f.retentionDays]), [["short", "workspace-short-retention", 30]]);
});

test("subnets without an NSG, except reserved names, NSG-refusing delegations and fully NIC-guarded subnets", () => {
  const V = "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet1";
  const NIC = "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces";
  const SS = "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/ss1";
  const sn = (subnet, o = {}) => ({ vnetId: V, vnet: "vnet1", resourceGroup: "rg", subscriptionId: "s1", subnet, subnetId: `${V}/subnets/${subnet}`, ...o });
  const rows = [
    sn("app", { ipConfigs: [`${NIC}/nic1/ipConfigurations/ip1`, `${NIC}/nic2/ipConfigurations/ip1`] }),
    sn("guarded", { ipConfigs: [`${NIC}/nic3/ipConfigurations/ip1`, `${SS}/virtualMachines/0/networkInterfaces/n/ipConfigurations/i`] }),
    sn("empty"),
    sn("withnsg", { nsg: "/x/nsg" }),
    sn("GatewaySubnet"),
    sn("azurebastionsubnet"),
    sn("anf", { delegations: ["Microsoft.Netapp/volumes"] }),
    sn("web", { delegations: ["Microsoft.Web/serverFarms"] }),
  ];
  const guarded = new Set([`${NIC}/nic1`, `${NIC}/nic3`, SS].map((x) => x.toLowerCase()));
  const found = net.judgeSubnets(rows, guarded);
  assert.deepEqual(found.map((f) => f.name), ["vnet1/app", "vnet1/empty", "vnet1/web"]);
  assert.ok(found.every((f) => f.kind === "subnet-no-nsg" && f.id.endsWith("#nsg")));
  assert.match(found[1].detail, /nothing in it yet/);
  assert.equal(net.ipConfigOwner("/subscriptions/s/resourceGroups/r/providers/Microsoft.Network/loadBalancers/lb/frontendIPConfigurations/f"), "");
});

test("default delete-lock types include workspaces, SQL servers, AKS and firewalls", () => {
  for (const t of ["microsoft.operationalinsights/workspaces", "microsoft.sql/servers", "microsoft.containerservice/managedclusters", "microsoft.network/azurefirewalls", "microsoft.keyvault/vaults"]) {
    assert.ok(DEFAULT_LOCK_TYPES.includes(t), t);
  }
});
