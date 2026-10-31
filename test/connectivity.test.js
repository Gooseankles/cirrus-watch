// Connectivity health: which VPN connections, ExpressRoute circuits, gateways, private endpoints and backend health
// metrics count as broken. Plain data in, no Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const t = require("../src/tools/connectivity")._test;

after(env.cleanup);

const RG = "/subscriptions/s1/resourceGroups/rg-net/providers/Microsoft.Network";

test("only IPsec and VNet-to-VNet connections that are not connected or failed are down", () => {
  const rows = [
    { id: `${RG}/connections/ok`, name: "ok", connectionType: "IPsec", status: "Connected", provisioningState: "Succeeded" },
    { id: `${RG}/connections/office`, name: "office", connectionType: "IPsec", status: "NotConnected", provisioningState: "Succeeded", peer: `${RG}/localNetworkGateways/lgw-office` },
    { id: `${RG}/connections/hub`, name: "hub", connectionType: "Vnet2Vnet", status: "Unknown", provisioningState: "Succeeded" },
    { id: `${RG}/connections/stuck`, name: "stuck", connectionType: "IPsec", status: "Connecting" },
    { id: `${RG}/connections/broken`, name: "broken", connectionType: "IPsec", status: "Connected", provisioningState: "Failed" },
    { id: `${RG}/connections/er`, name: "er", connectionType: "ExpressRoute", status: "Unknown" },
    { id: `${RG}/connections/nostatus`, name: "nostatus", connectionType: "IPsec", status: "" },
  ];
  const found = t.judgeConnections(rows);
  assert.deepEqual(found.map((f) => f.name), ["office", "hub", "stuck", "broken"]);
  assert.ok(found.every((f) => f.kind === "conn-vpn-down" && f.subscriptionId === "s1" && f.resourceGroup === "rg-net"));
  assert.equal(found[0].id, `${RG}/connections/office#vpn-down`);
  assert.match(found[0].detail, /^Site-to-site VPN connection to lgw-office is NotConnected/);
  assert.match(found[1].detail, /^VNet-to-VNet connection is Unknown/);
  assert.match(found[2].detail, /stuck connecting/);
  assert.match(found[3].detail, /failed state/);
});

test("ExpressRoute: provider not provisioned, circuit not enabled and private peering off", () => {
  const found = t.judgeCircuits([
    { id: `${RG}/expressRouteCircuits/fine`, name: "fine", providerState: "Provisioned", circuitState: "Enabled", peerings: [{ name: "AzurePrivatePeering", properties: { peeringType: "AzurePrivatePeering", state: "Enabled" } }] },
    { id: `${RG}/expressRouteCircuits/new`, name: "new", providerState: "NotProvisioned", circuitState: "Enabled", provider: "Equinix", peerings: [] },
    { id: `${RG}/expressRouteCircuits/off`, name: "off", providerState: "Provisioned", circuitState: "Disabled" },
    {
      id: `${RG}/expressRouteCircuits/peer`, name: "peer", providerState: "Provisioned", circuitState: "Enabled",
      peerings: JSON.stringify([
        { properties: { peeringType: "MicrosoftPeering", state: "Disabled" } },
        { properties: { peeringType: "AzurePrivatePeering", state: "Disabled" } },
      ]),
    },
  ]);
  assert.deepEqual(found.map((f) => [f.name, f.kind]), [
    ["new", "conn-er-circuit-down"],
    ["off", "conn-er-circuit-down"],
    ["peer", "conn-er-peering-disabled"],
  ]);
  assert.match(found[0].detail, /provider with Equinix has the circuit as NotProvisioned/);
  assert.equal(new Set(found.map((f) => f.id)).size, 3);
});

test("gateways in a failed provisioning state", () => {
  const found = t.judgeGateways([
    { id: `${RG}/virtualNetworkGateways/vgw`, name: "vgw", type: "microsoft.network/virtualnetworkgateways", gatewayType: "Vpn", provisioningState: "Failed" },
    { id: `${RG}/vpnGateways/vwan`, name: "vwan", type: "microsoft.network/vpngateways", provisioningState: "failed" },
    { id: `${RG}/virtualNetworkGateways/ok`, name: "ok", type: "microsoft.network/virtualnetworkgateways", provisioningState: "Succeeded" },
  ]);
  assert.deepEqual(found.map((f) => f.name), ["vgw", "vwan"]);
  assert.match(found[0].detail, /^Virtual network gateway \(Vpn\) is in a failed/);
  assert.match(found[1].detail, /^Virtual WAN VPN gateway/);
});

test("private endpoints: only Pending is flagged (Rejected and Disconnected belong to Orphaned resources)", () => {
  const found = t.judgePendingEndpoints([
    { id: `${RG}/privateEndpoints/pe1`, name: "pe1", status: "Pending", target: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/st1", manual: true },
    { id: `${RG}/privateEndpoints/pe2`, name: "pe2", status: "Rejected" },
    { id: `${RG}/privateEndpoints/pe3`, name: "pe3", status: "Disconnected" },
    { id: `${RG}/privateEndpoints/pe4`, name: "pe4", status: "Approved" },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "conn-pe-pending");
  assert.match(found[0].detail, /owner of st1 to approve the connection \(manual approval\)/);
});

test("a private endpoint with no DNS zone config is flagged", () => {
  const pe = { id: `${RG}/privateEndpoints/pe1`, name: "pe1", target: "/x/providers/Microsoft.KeyVault/vaults/kv1" };
  assert.equal(t.judgeDnsZoneGroups(pe, []).length, 1);
  assert.equal(t.judgeDnsZoneGroups(pe, [{ name: "default", properties: { privateDnsZoneConfigs: [] } }]).length, 1);
  assert.equal(t.judgeDnsZoneGroups(pe, [{ name: "default", properties: { privateDnsZoneConfigs: [{ name: "privatelink-vaultcore-azure-net" }] } }]).length, 0);
  assert.match(t.judgeDnsZoneGroups(pe, [])[0].detail, /record for kv1/);
});

// The shape Azure Monitor answers with.
const metrics = (series) => ({
  value: [{
    name: { value: "m" },
    timeseries: series.map(([dims, points]) => ({
      metadatavalues: Object.entries(dims).map(([k, v]) => ({ name: { value: k, localizedValue: k }, value: v })),
      data: points.map((p) => (p === null ? { timeStamp: "2026-10-31T10:00:00Z" } : { timeStamp: "2026-10-31T10:00:00Z", average: p })),
    })),
  }],
});

test("metric series are averaged over their data points; empty series are dropped", () => {
  const s = t.seriesAverages(metrics([
    [{ BackendIPAddress: "10.0.0.4" }, [100, 50, null]],
    [{ BackendIPAddress: "10.0.0.5" }, [null, null]],
  ]));
  assert.deepEqual(s, [{ dims: { backendipaddress: "10.0.0.4" }, avg: 75 }]);
  assert.deepEqual(t.seriesAverages({}), []);
});

test("application gateway: unhealthy hosts above 0 name the pools", () => {
  const agw = { id: `${RG}/applicationGateways/agw1`, name: "agw1" };
  const healthy = t.seriesAverages(metrics([[{ BackendSettingsPool: "pool-a~http" }, [0, 0]]]));
  assert.deepEqual(t.judgeAppGateway(agw, healthy), []);
  const bad = t.seriesAverages(metrics([
    [{ BackendSettingsPool: "pool-a~http" }, [0, 0]],
    [{ BackendSettingsPool: "pool-b~https" }, [1, 2]],
  ]));
  const [f] = t.judgeAppGateway(agw, bad);
  assert.equal(f.kind, "conn-agw-unhealthy");
  assert.equal(f.id, `${RG}/applicationGateways/agw1#agw-unhealthy`);
  assert.match(f.detail, /On average 1.5 backend host\(s\) failed .* \(pool pool-b\)/);
});

test("load balancer and Front Door: health under the threshold, per backend or origin", () => {
  const lb = { id: `${RG}/loadBalancers/lb1`, name: "lb1" };
  const series = t.seriesAverages(metrics([
    [{ BackendIPAddress: "10.0.0.4" }, [100, 100]],
    [{ BackendIPAddress: "10.0.0.5" }, [0, 0]],
    [{ BackendIPAddress: "10.0.0.6" }, [100, 99]],
  ]));
  const [f] = t.judgeHealthPercent(lb, series, t.HEALTH.lb);
  assert.equal(f.kind, "conn-lb-unhealthy");
  assert.equal(f.id, `${RG}/loadBalancers/lb1#lb-unhealthy`);
  assert.match(f.detail, /below 100% over the last hour: 10.0.0.5 0%, 10.0.0.6 99.5%/);
  // A lower threshold lets a short dip pass.
  const [g] = t.judgeHealthPercent(lb, series, { ...t.HEALTH.lb, threshold: 90 });
  assert.match(g.detail, /below 90%.*: 10.0.0.5 0%\./);
  const afd = { id: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Cdn/profiles/fd1", name: "fd1" };
  assert.deepEqual(t.judgeHealthPercent(afd, t.seriesAverages(metrics([[{}, [100]]])), t.HEALTH.afd), []);
  const [h] = t.judgeHealthPercent(afd, t.seriesAverages(metrics([[{}, [50]]])), t.HEALTH.afd);
  assert.equal(h.kind, "conn-fd-unhealthy");
  assert.match(h.detail, /^Origin health below 100% over the last hour: 50%\./);
});
