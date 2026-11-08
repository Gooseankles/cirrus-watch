// The End of life scan: runtime and operating system end dates, the retirement
// judgement, and the run with its five parts (a failing part is one scan-error
// finding, the rest stays). Azure, endoflife.date and the log are stubbed.
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const arm = require("../src/armClient");
const eolDates = require("../src/eolDates");
const log = require("../src/log");

let graph = () => [];
// Before the tool is loaded: it takes the client functions when required.
arm.resourceGraphQuery = async (kql) => graph(kql);
arm.armGet = async () => ({ values: [], properties: {} });
eolDates.load = async () => ({ tables: {}, source: "built-in" });
log.record = () => {};
const tool = require("../src/tools/endOfLife");
const { runtimeOf, runtimeEol, osEol, retirementFindings, setLive } = tool._test;

after(env.cleanup);
beforeEach(() => {
  graph = () => [];
  setLive({});
});

const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

test("runtimes: stack and version from the Linux fx string or the Windows .NET version, with the end date", () => {
  assert.deepEqual(runtimeOf({ linuxFxVersion: "NODE|18-lts" }), { stack: "node", version: "18-lts" });
  assert.deepEqual(runtimeOf({ linuxFxVersion: "DOTNETCORE|8.0" }), { stack: "dotnet", version: "8.0" });
  assert.deepEqual(runtimeOf({ netFrameworkVersion: "v6.0" }), { stack: "dotnet", version: "6" });
  assert.equal(runtimeOf({ netFrameworkVersion: "v4.0", phpVersion: "7.4" }), null, "a Windows app's default PHP version is not trusted");
  assert.equal(runtimeEol({ stack: "node", version: "18-lts" }), "2025-04-30");
  assert.equal(runtimeEol({ stack: "dotnet", version: "3.1" }), "2022-12-13");
  assert.equal(runtimeEol({ stack: "python", version: "3.11" }), "2027-10-31");
  assert.equal(runtimeEol({ stack: "python", version: "3.99" }), undefined);
  setLive({ node: { 28: "2030-04-30" } });
  assert.equal(runtimeEol({ stack: "node", version: "28" }), "2030-04-30", "live dates fill the gaps");
});

test("operating systems: Windows Server year from the image, Linux from the built-in table or the live dates", () => {
  assert.deepEqual(osEol({ osType: "Windows", offer: "WindowsServer", sku: "2012-R2-Datacenter" }), { os: "Windows Server 2012", end: "2023-10-10" });
  assert.deepEqual(osEol({ osType: "Windows", offer: "sql2019-ws2022", sku: "standard" }), { os: "Windows Server 2022", end: "2031-10-14" });
  assert.deepEqual(osEol({ osType: "Linux", offer: "UbuntuServer", sku: "18.04-LTS" }), { os: "Ubuntu 18.04", end: "2023-05-31" });
  assert.equal(osEol({ osType: "Linux", offer: "0001-com-ubuntu-server-jammy", sku: "22_04-lts" }).os, "Ubuntu 22.04");
  assert.equal(osEol({ osType: "Linux", offer: "ubuntu-24_04-lts", sku: "server" }), null, "unknown without the live dates");
  setLive({ ubuntu: { "24.04": "2029-05-31" } });
  assert.deepEqual(osEol({ osType: "Linux", offer: "ubuntu-24_04-lts", sku: "server" }), { os: "Ubuntu 24.04", end: "2029-05-31" });
});

test("retirements: past, soon and planned by the date; the Advisor recommendation id is the finding id", () => {
  const rows = [
    { id: "/subscriptions/s/providers/Microsoft.Advisor/recommendations/r1", subscriptionId: "s", resourceGroup: "rg", resourceId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip1", impacted: "", problem: "Basic SKU public IP", solution: "Upgrade to Standard", retirementDate: "2025-09-30T00:00:00Z", feature: "Basic public IP", link: "https://aka.ms/x" },
    { id: "r2", subscriptionId: "s", resourceGroup: "rg", resourceId: "", impacted: "vm1", problem: "Thing", solution: "", retirementDate: daysFromNow(30), feature: "", link: "" },
    { id: "r3", subscriptionId: "s", resourceGroup: "rg", resourceId: "", impacted: "vm2", problem: "Later", solution: "", retirementDate: daysFromNow(400), feature: "", link: "" },
    { id: "r4", subscriptionId: "s", resourceGroup: "", resourceId: "", impacted: "", problem: "No date", solution: "", retirementDate: "", feature: "", link: "" },
  ];
  const out = retirementFindings(rows, 180);
  assert.deepEqual(out.map((f) => [f.kind, f.id, f.name]), [
    ["retirement-past", rows[0].id, "pip1"],
    ["retirement-soon", "r2", "vm1"],
    ["retirement-planned", "r3", "vm2"],
    ["retirement-planned", "r4", "No date"],
  ]);
  assert.equal(out[0].expires, "2025-09-30");
  assert.equal(out[0].detail, "Basic public IP. Upgrade to Standard. https://aka.ms/x");
  assert.equal(out[3].expires, undefined);
  assert.equal(out[3].resourceGroup, null);
});

test("run: the retirement part reports beside the others; a failing part is one scan error and the rest stays", async () => {
  graph = (kql) => {
    if (/advisorresources/.test(kql)) return [{ id: "r1", subscriptionId: "s", resourceGroup: "rg", impacted: "pip1", problem: "Basic SKU public IP", retirementDate: daysFromNow(10) }];
    if (/storageaccounts/.test(kql)) return [{ id: "/s/sa1", name: "sa1", type: "microsoft.storage/storageaccounts", resourceGroup: "rg", subscriptionId: "s", tls: "TLS1_0" }];
    return [];
  };
  let out = await tool.run();
  assert.deepEqual(out.map((f) => [f.kind, f.id]).sort(), [["retirement-soon", "r1"], ["tls-old-allowed", "/s/sa1#tls"]]);

  graph = (kql) => {
    if (/advisorresources/.test(kql)) throw new Error("Resource Graph failed (500): boom");
    if (/storageaccounts/.test(kql)) return [{ id: "/s/sa1", name: "sa1", type: "microsoft.storage/storageaccounts", resourceGroup: "rg", subscriptionId: "s", tls: "TLS1_0" }];
    return [];
  };
  out = await tool.run();
  assert.deepEqual(out.map((f) => [f.kind, f.id]).sort(), [["scan-error", "end-of-life/scan-errors/Service retirements"], ["tls-old-allowed", "/s/sa1#tls"]]);
  assert.match(out.find((f) => f.kind === "scan-error").detail, /boom/);
});
