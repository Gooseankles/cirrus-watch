// Certificates: application gateway certificates read from the gateway's settings (PKCS#7 bundles as ARM returns
// them), Key Vault references pinned to a version, the gateway address list and the live listener targets (host
// names, wildcards, basic listeners, private frontends). Plain data in, no Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const t = require("../src/tools/certificates")._test;

after(env.cleanup);

// Made with openssl: a leaf for shop.contoso.test (valid until 2027-10-31) signed by "Test Root" (valid until 2036),
// bundled leaf + root as PKCS#7 DER, and the root alone as DER.
const BUNDLE = "MIIDTAYJKoZIhvcNAQcCoIIDPTCCAzkCAQExADALBgkqhkiG9w0BBwGgggMhMIIBazCCARCgAwIBAgIUTrlSZYwvSEYFIyi2Bwty5zSap00wCgYIKoZIzj0EAwIwLDEWMBQGA1UECgwNVGVzdCBSb290IE9yZzESMBAGA1UEAwwJVGVzdCBSb290MB4XDTI2MTAzMTIxNDI1MFoXDTI3MTAzMTIxNDI1MFowHDEaMBgGA1UEAwwRc2hvcC5jb250b3NvLnRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR1jPlu0bqoyovD0y0TNKK8xWFLL7UnHGaId1kuybfMSTj+0ZiEQN8neZY3qpRZPcW4I1srCvn/oFYcaxKgN6XRoyAwHjAcBgNVHREEFTATghFzaG9wLmNvbnRvc28udGVzdDAKBggqhkjOPQQDAgNJADBGAiEAzzGIK/QFCKxP+1slYJrFa+EcIew7HeIG3h/iwyTjpAICIQCzHP0njgwrvH62aadScKYBfF15wdVpledA3a6f+Q6x9zCCAa4wggFToAMCAQICFBnPOgjr1M5Xq3GRFJas1PmkJF4NMAoGCCqGSM49BAMCMCwxFjAUBgNVBAoMDVRlc3QgUm9vdCBPcmcxEjAQBgNVBAMMCVRlc3QgUm9vdDAeFw0yNjEwMzEyMTQyNTBaFw0zNjEwMjgyMTQyNTBaMCwxFjAUBgNVBAoMDVRlc3QgUm9vdCBPcmcxEjAQBgNVBAMMCVRlc3QgUm9vdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABGmUPH5Kgvq5YOH8+2XQ6Cu0IDcf6QMVzdA1EeGehEKxzR1YwRUwBMs0g6KRA4tmcNovFFgGzxTrU7fVloneFfWjUzBRMB0GA1UdDgQWBBR9PerBaDD0Zd59LFExe/ADayUeSDAfBgNVHSMEGDAWgBR9PerBaDD0Zd59LFExe/ADayUeSDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQC6AByk9/kxJJeI0Oo5F+893yKwFZLRe057kb4IWhRsUQIhAPG8lyUPYwxAN5mOMF7uxlBs7CRO+c2Q/xsFy0R209J0MQA=";
const ROOT = "MIIBrjCCAVOgAwIBAgIUGc86COvUzlercZEUlqzU+aQkXg0wCgYIKoZIzj0EAwIwLDEWMBQGA1UECgwNVGVzdCBSb290IE9yZzESMBAGA1UEAwwJVGVzdCBSb290MB4XDTI2MTAzMTIxNDI1MFoXDTM2MTAyODIxNDI1MFowLDEWMBQGA1UECgwNVGVzdCBSb290IE9yZzESMBAGA1UEAwwJVGVzdCBSb290MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaZQ8fkqC+rlg4fz7ZdDoK7QgNx/pAxXN0DUR4Z6EQrHNHVjBFTAEyzSDopEDi2Zw2i8UWAbPFOtTt9WWid4V9aNTMFEwHQYDVR0OBBYEFH096sFoMPRl3n0sUTF78ANrJR5IMB8GA1UdIwQYMBaAFH096sFoMPRl3n0sUTF78ANrJR5IMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhALoAHKT3+TEkl4jQ6jkX7z3fIrAVktF7TnuRvghaFGxRAiEA8byXJQ9jDEA3mY4wXu7GUGzsJE75zZD/GwXLRHbT0nQ=";
const LEAF_END = Date.parse("2027-10-31T21:42:50Z");
const DAY = 86400000;

const GW = "/subscriptions/s1/resourceGroups/rg-web/providers/Microsoft.Network/applicationGateways/agw-web";
const ref = (kind, name) => ({ id: `${GW}/${kind}/${name}` });

function gateway({ kv = "", data = BUNDLE, rootData = ROOT } = {}) {
  return {
    id: GW,
    name: "agw-web",
    resourceGroup: "rg-web",
    subscriptionId: "s1",
    certs: [
      { ...ref("sslCertificates", "shop"), name: "shop", properties: { publicCertData: data, keyVaultSecretId: kv } },
      { ...ref("sslCertificates", "unused"), name: "unused", properties: { publicCertData: BUNDLE } },
    ],
    roots: [{ ...ref("trustedRootCertificates", "backend-root"), name: "backend-root", properties: { data: rootData } }],
    listeners: [
      { name: "https-shop", properties: { protocol: "Https", sslCertificate: ref("sslCertificates", "shop"), hostNames: ["shop.contoso.test", "*.contoso.test"], frontendIPConfiguration: ref("frontendIPConfigurations", "public"), frontendPort: ref("frontendPorts", "p8443") } },
      { name: "https-private", properties: { protocol: "Https", sslCertificate: ref("sslCertificates", "shop"), hostName: "intra.contoso.test", frontendIPConfiguration: ref("frontendIPConfigurations", "private"), frontendPort: ref("frontendPorts", "p443") } },
      { name: "https-basic", properties: { protocol: "Https", sslCertificate: ref("sslCertificates", "shop"), frontendIPConfiguration: ref("frontendIPConfigurations", "public"), frontendPort: ref("frontendPorts", "p443") } },
      { name: "http", properties: { protocol: "Http", hostName: "plain.contoso.test", frontendIPConfiguration: ref("frontendIPConfigurations", "public") } },
    ],
    backendSettings: [{ name: "https-backend", properties: { trustedRootCertificates: [ref("trustedRootCertificates", "backend-root")] } }],
    frontends: [
      { ...ref("frontendIPConfigurations", "public"), properties: { publicIPAddress: { id: "/subscriptions/s1/resourceGroups/rg-web/providers/Microsoft.Network/publicIPAddresses/pip-agw" } } },
      { ...ref("frontendIPConfigurations", "private"), properties: { privateIPAddress: "10.0.1.10" } },
    ],
    ports: [
      { ...ref("frontendPorts", "p443"), properties: { port: 443 } },
      { ...ref("frontendPorts", "p8443"), properties: { port: 8443 } },
    ],
  };
}

test("a PKCS#7 bundle and a single DER certificate are both read; the leaf is the one that issued nothing", () => {
  const chain = t.certsFromBase64(BUNDLE);
  assert.equal(chain.length, 2);
  assert.match(t.leafOf(chain).subject, /CN=shop\.contoso\.test/);
  assert.equal(t.certsFromBase64(ROOT).length, 1);
  assert.deepEqual(t.certsFromBase64("bm90IGEgY2VydA=="), []);
  assert.deepEqual(t.certsFromBase64(""), []);
});

test("gateway certificates in use that expire soon are found, unused ones are not", () => {
  const { findings, read } = t.judgeGateway(gateway(), 30, LEAF_END - 10 * DAY);
  assert.deepEqual(findings.map((f) => [f.kind, f.name]), [["cert-expiring", "agw-web/shop"]]);
  const f = findings[0];
  assert.equal(f.id, `${GW}/sslCertificates/shop`);
  assert.equal(f.expires, "2027-10-31");
  assert.equal(f.subscriptionId, "s1");
  assert.match(f.detail, /listeners https-shop, https-private/);
  assert.match(f.detail, /Expires in 10 day\(s\) \(shop\.contoso\.test, issued by Test Root Org/);
  assert.match(f.detail, /uploaded to the gateway/);
  assert.ok(read.has(`${GW}/sslcertificates/shop`.toLowerCase()));
});

test("expired listener certificate and expired trusted root are both critical findings", () => {
  const { findings } = t.judgeGateway(gateway(), 30, Date.parse("2040-01-01"));
  assert.deepEqual(findings.map((f) => f.kind).sort(), ["cert-expired", "cert-expired"]);
  const root = findings.find((f) => f.id.endsWith("/trustedRootCertificates/backend-root"));
  assert.match(root.detail, /HTTPS backends \(https-backend\)/);
});

test("a Key Vault secret id with a version is pinned; without the version it is not", () => {
  const pinned = "https://kv-web.vault.azure.net/secrets/shop/0123456789abcdef0123456789abcdef";
  const { findings } = t.judgeGateway(gateway({ kv: pinned }), 30, LEAF_END - 100 * DAY);
  assert.deepEqual(findings.map((f) => f.kind), ["agw-cert-kv-pinned"]);
  assert.equal(findings[0].id, `${GW}/sslCertificates/shop#kv-pinned`);
  assert.match(findings[0].detail, /kv-web\.vault\.azure\.net\/secrets\/shop\/0123/);
  const free = t.judgeGateway(gateway({ kv: "https://kv-web.vault.azure.net/secrets/shop/" }), 30, LEAF_END - 5 * DAY).findings;
  assert.deepEqual(free.map((f) => f.kind), ["cert-expiring"]);
  assert.match(free[0].detail, /comes from Key Vault/);
  assert.ok(!t.PINNED_SECRET.test("https://kv-web.vault.azure.net/secrets/shop"));
});

const PIP = "/subscriptions/s1/resourcegroups/rg-web/providers/microsoft.network/publicipaddresses/pip-agw";
const IPS = new Map([[PIP, { ip: "20.1.2.3", fqdn: "agw-web.westeurope.cloudapp.azure.com" }]]);

test("address list: every frontend with its address and every listener with port, host names, frontend and certificate", () => {
  const g = t.gatewayAddresses(gateway(), IPS);
  assert.equal(g.name, "agw-web");
  assert.deepEqual(g.frontends, [
    { name: "public", kind: "public", ip: "20.1.2.3", fqdn: "agw-web.westeurope.cloudapp.azure.com" },
    { name: "private", kind: "private", ip: "10.0.1.10", fqdn: null },
  ]);
  const by = Object.fromEntries(g.listeners.map((l) => [l.name, l]));
  assert.deepEqual(Object.keys(by), ["https-shop", "https-private", "https-basic", "http"]);
  assert.deepEqual(by["https-shop"].hostNames, ["shop.contoso.test", "*.contoso.test"], "wildcards are listed as written");
  assert.equal(by["https-shop"].port, 8443);
  assert.equal(by["https-shop"].certificate, "shop");
  assert.equal(by["https-shop"].fqdn, "agw-web.westeurope.cloudapp.azure.com");
  assert.equal(by["https-private"].frontendKind, "private");
  assert.equal(by["https-private"].ip, "10.0.1.10");
  assert.deepEqual(by["https-basic"].hostNames, [], "a basic listener has no host name");
  assert.equal(by.http.protocol, "HTTP");
  assert.equal(by.http.port, 80, "a listener whose port is not in the list falls back to the protocol's port");
  assert.equal(by.http.certificate, null);
  // An older plain ip map still works; a public IP with no address leaves ip empty.
  const old = t.gatewayFrontends(gateway(), new Map([[PIP, "20.1.2.3"]]));
  assert.deepEqual(old[0], { ref: `${GW}/frontendIPConfigurations/public`.toLowerCase(), name: "public", kind: "public", ip: "20.1.2.3", fqdn: null });
  assert.equal(t.gatewayFrontends(gateway(), new Map())[0].ip, null);
});

test("live targets: host names with SNI, wildcards with a made-up name they match, basic listeners with no SNI, private IPs too", () => {
  const { rows } = t.judgeGateway(gateway(), 30, LEAF_END - 100 * DAY);
  const targets = t.gatewayTargets(gateway(), IPS, rows);
  const by = Object.fromEntries(targets.map((x) => [x.label, x]));
  assert.deepEqual(Object.keys(by), ["shop.contoso.test:8443", "*.contoso.test:8443", "20.1.2.3:443", "intra.contoso.test"], "public first; plain HTTP is skipped");

  const host = by["shop.contoso.test:8443"];
  assert.equal(host.host, "20.1.2.3");
  assert.equal(host.port, 8443);
  assert.equal(host.sni, "shop.contoso.test");
  assert.equal(host.name, "shop.contoso.test");
  assert.equal(host.address, "20.1.2.3:8443");
  assert.equal(host.skipExpiry, true, "expiry comes from the settings, or once per certificate");
  assert.equal(host.skipUnreachable, true, "no answer is never a finding");
  assert.equal(host.inventory, false);
  assert.match(host.expectThumb, /^[0-9A-F]{40}$/, "the settings gave the certificate, so the served one is compared");
  assert.equal(host.id, `${GW}/listeners/https-shop/shop.contoso.test`);

  const wild = by["*.contoso.test:8443"];
  assert.equal(wild.sni, "cirrus-watch-probe.contoso.test");
  assert.equal(wild.name, "cirrus-watch-probe.contoso.test", "the name is judged against the wildcard through a name it matches");
  assert.equal(wild.nameShown, "*.contoso.test");
  assert.equal(wild.sniShown, "*.contoso.test");
  assert.match(wild.where, /as cirrus-watch-probe\.contoso\.test \(matches \*\.contoso\.test\)/);

  const basic = by["20.1.2.3:443"];
  assert.equal(basic.sni, undefined, "a basic listener is reached with no SNI");
  assert.equal(basic.name, "20.1.2.3", "an IP: no name is judged");
  assert.equal(basic.sniShown, null);
  assert.equal(basic.id, `${GW}/listeners/https-basic/basic`);
  assert.match(basic.where, /public address 20\.1\.2\.3:443 with no host name/);

  const priv = by["intra.contoso.test"];
  assert.equal(priv.host, "10.0.1.10");
  assert.equal(priv.frontendKind, "private");
  assert.equal(priv.sni, "intra.contoso.test");

  assert.equal(new Set(targets.map((x) => x.key)).size, targets.length, "each target has its own key");
  const unread = t.gatewayTargets(gateway(), IPS, []);
  assert.equal(unread[0].expectThumb, null, "nothing to compare when the settings gave no certificate");
  assert.equal(t.gatewayTargets(gateway(), new Map(), rows).length, 1, "a public frontend without an address is not probed; the private one still is");
  process.env.CERT_PROBE_PRIVATE = "off";
  try {
    const pub = t.gatewayTargets(gateway(), IPS, rows);
    assert.ok(pub.length && pub.every((x) => x.frontendKind === "public"), "CERT_PROBE_PRIVATE off skips private IPs");
  } finally {
    delete process.env.CERT_PROBE_PRIVATE;
  }
});

test("a wildcard becomes a name it matches", () => {
  assert.equal(t.wildcardProbeName("*.contoso.test"), "cirrus-watch-probe.contoso.test");
  assert.equal(t.wildcardProbeName("shop?.contoso.test"), "shopx.contoso.test");
});

test("after the live checks: listeners get their checks; a Key Vault certificate the settings could not read takes the worst live answer, reported once", () => {
  const kv = "https://kv-web.vault.azure.net/secrets/shop";
  const gw = gateway({ kv, data: "" });
  const { rows } = t.judgeGateway(gw, 30, LEAF_END);
  const listing = t.gatewayAddresses(gw, IPS);
  const targets = t.gatewayTargets(gw, IPS, rows);
  const live = (days) => ({ status: "expiring", subject: "shop.contoso.test", issuer: "Test Root Org", expires: "2026-11-12", days, thumbprint: "AB" });
  targets[0].live = live(20);
  targets[1].live = live(10);
  targets[2].live = { status: "unreachable", note: "no answer within 10 s" };
  // targets[3] (the private one) was never run.
  const findings = t.finishGateways([listing], targets, rows, 30);

  assert.deepEqual(findings.map((f) => [f.kind, f.id]), [["cert-expiring", `${GW}/sslCertificates/shop`]], "one finding per certificate, not per address");
  assert.match(findings[0].detail, /read from a live connection to 20\.1\.2\.3:8443/);
  assert.match(findings[0].detail, /Expires in 10 day\(s\)/);
  const shop = rows.find((r) => r.name === "agw-web/shop");
  assert.equal(shop.status, "expiring");
  assert.equal(shop.days, 10);
  assert.equal(shop.source, "Key Vault, read live");
  assert.match(shop.note, /^Expiry not readable from the gateway settings; checked live on 20\.1\.2\.3:8443 \(\*\.contoso\.test\)/);

  const by = Object.fromEntries(listing.listeners.map((l) => [l.name, l]));
  assert.deepEqual(by["https-shop"].checks.map((c) => [c.address, c.sni, c.status]), [["20.1.2.3:8443", "shop.contoso.test", "expiring"], ["20.1.2.3:8443", "*.contoso.test", "expiring"]]);
  assert.deepEqual(by["https-basic"].checks.map((c) => [c.sni, c.status, c.note]), [[null, "unreachable", "no answer within 10 s"]]);
  assert.equal(by["https-private"].checks[0].status, "unchecked");
  assert.equal(by["https-private"].checks[0].frontendKind, "private");
  assert.deepEqual(by.http.checks, []);
  assert.equal(by["https-shop"].certStatus, "expiring");
  assert.equal(by["https-shop"].certSource, "Key Vault, read live");
  assert.equal(by["https-shop"].certRef, undefined, "the internal reference is not saved");

  // Nobody answered: the row says it is not readable, and nothing is reported.
  const again = t.judgeGateway(gw, 30, LEAF_END).rows;
  const quiet = t.gatewayTargets(gw, IPS, again).map((x) => ({ ...x, live: { status: "unreachable", note: "refused" } }));
  assert.deepEqual(t.finishGateways([t.gatewayAddresses(gw, IPS)], quiet, again, 30), []);
  const row = again.find((r) => r.name === "agw-web/shop");
  assert.equal(row.status, "unread");
  assert.match(row.note, /^Not readable: the gateway settings do not give its expiry and no listener answered the dashboard/);
});

test("the list holds every gateway certificate with where it is used, also unused and healthy ones", () => {
  const { rows } = t.judgeGateway(gateway(), 30, LEAF_END - 100 * DAY);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(by).sort(), ["agw-web/backend-root", "agw-web/shop", "agw-web/unused"]);
  assert.equal(by["agw-web/shop"].status, "ok");
  assert.equal(by["agw-web/shop"].days, 100);
  assert.equal(by["agw-web/shop"].subject, "shop.contoso.test");
  assert.equal(by["agw-web/shop"].issuer, "Test Root Org");
  assert.equal(by["agw-web/shop"].source, "Uploaded");
  assert.match(by["agw-web/shop"].usedBy, /listeners https-shop, https-private/);
  assert.match(by["agw-web/shop"].thumbprint, /^[0-9A-F]{40}$/);
  assert.equal(by["agw-web/unused"].status, "unused");
  assert.equal(by["agw-web/backend-root"].type, "root");
  assert.equal(by["agw-web/backend-root"].status, "ok");
  const pinned = t.judgeGateway(gateway({ kv: "https://kv/secrets/shop/0123456789abcdef", data: "" }), 30, LEAF_END).rows.find((r) => r.name === "agw-web/shop");
  assert.equal(pinned.status, "unread", "a listener certificate whose public part did not come back");
  assert.equal(pinned.source, "Key Vault (one version)");
});

test("App Service certificates are bound to the custom domains whose binding has their thumbprint", () => {
  const sites = [
    { host: "shop.contoso.test", source: "app-shop", thumb: "AB12" },
    { host: "www.contoso.test", source: "app-www", thumb: "AB12" },
    { host: "other.test", source: "app-o", thumb: "FF00" },
  ];
  const now = Date.parse("2027-01-01");
  const rows = t.appServiceRows([
    { id: "c1", name: "shop-cert", thumb: "AB12", expires: "2027-01-11T00:00:00Z", issuer: "CN=R3, O=Let's Encrypt, C=US", subject: "contoso.test", kv: "" },
    { id: "c2", name: "old-cert", thumb: "CD34", expires: "2026-06-01T00:00:00Z", issuer: "CN=Old CA", subject: "old.test", kv: "/subscriptions/s/kv" },
  ], sites, 30, now);
  assert.equal(rows[0].status, "expiring");
  assert.equal(rows[0].usedBy, "shop.contoso.test, www.contoso.test (web apps app-shop, app-www)");
  assert.equal(rows[0].issuer, "Let's Encrypt");
  assert.equal(rows[0].source, "App Service");
  assert.equal(rows[1].status, "unused", "an expired certificate nothing uses is listed, not flagged");
  assert.equal(rows[1].issuer, "Old CA");
  assert.equal(rows[1].source, "Key Vault");
});

test("an address that does not answer is listed as no answer; a filtered gateway listener is not listed", async () => {
  const down = { host: "127.0.0.1", port: 9, name: "down.test", label: "down.test", type: "listed" };
  const r = await t.check(down, 30);
  assert.deepEqual(r.findings.map((f) => f.kind), ["cert-unreachable"]);
  assert.equal(r.row.status, "unreachable");
  assert.equal(r.row.usedBy, "Listed in Settings");
  const gw = await t.check({ ...down, skipUnreachable: true, inventory: false }, 30);
  assert.deepEqual(gw.findings, []);
  assert.equal(gw.row, null);
  assert.equal(gw.live.status, "unreachable", "the gateway list still says it did not answer");
});

test("live judgement on gateway listeners: wildcards judged through their made-up name, no name check without SNI, a served certificate that differs is found", async () => {
  const { rows } = t.judgeGateway(gateway(), 30, LEAF_END - 100 * DAY);
  const by = Object.fromEntries(t.gatewayTargets(gateway(), IPS, rows).map((x) => [x.label, x]));
  const peer = (san, fp = "AA:BB") => ({ subject: { CN: san.split(",")[0].replace("DNS:", "") }, issuer: { O: "Test CA" }, subjectaltname: san, valid_to: new Date(Date.now() + 200 * DAY).toUTCString(), fingerprint: fp });
  const answer = (cert) => async () => ({ cert, authorized: true, authError: null });
  const kinds = (r) => r.findings.map((f) => f.kind).sort();

  // A wildcard certificate on the wildcard listener: right name; it is not the certificate the settings name.
  const wild = await t.check(by["*.contoso.test:8443"], 30, answer(peer("DNS:*.contoso.test")));
  assert.deepEqual(kinds(wild), ["agw-cert-served-differs"]);
  assert.equal(wild.live.status, "differs");
  assert.equal(wild.live.nameChecked, true);
  assert.equal(wild.row, null, "gateway listeners are listed from the settings, not again");
  assert.match(wild.findings[0].detail, /than the one its settings name \(shop\)/);

  // The configured certificate, but not for the wildcard: a wrong name, said against the wildcard as written.
  const thumb = by["*.contoso.test:8443"].expectThumb.match(/../g).join(":");
  const narrow = await t.check(by["*.contoso.test:8443"], 30, answer(peer("DNS:shop.contoso.test", thumb)));
  assert.deepEqual(kinds(narrow), ["cert-name-mismatch"]);
  assert.match(narrow.findings[0].detail, /not for \*\.contoso\.test \(tried as cirrus-watch-probe\.contoso\.test\)/);

  // A basic listener reached with no SNI: whatever name the certificate has, no name finding.
  const basic = await t.check(by["20.1.2.3:443"], 30, answer(peer("DNS:other.example", thumb)));
  assert.deepEqual(kinds(basic), []);
  assert.equal(basic.live.status, "ok");
  assert.equal(basic.live.nameChecked, false);

  // Expiry is never reported from a gateway listener's live answer (settings, or once per certificate).
  const soon = { ...peer("DNS:shop.contoso.test", thumb), valid_to: new Date(Date.now() + 3 * DAY).toUTCString() };
  const host = await t.check(by["shop.contoso.test:8443"], 30, answer(soon));
  assert.deepEqual(kinds(host), []);
  assert.equal(host.live.status, "expiring");
});

test("renewal grace: a Key Vault secret without a version is not reported while the gateway serves the renewal or has not picked it up yet", async () => {
  const LEAF_FROM = Date.parse("2026-10-31T21:42:50Z");
  const targetOf = (kv) => {
    const gw = gateway({ kv });
    const { rows } = t.judgeGateway(gw, 30, LEAF_FROM + DAY);
    return t.gatewayTargets(gw, IPS, rows).find((x) => x.label === "shop.contoso.test:8443");
  };
  const latest = targetOf("https://kv-web.vault.azure.net/secrets/shop");
  assert.equal(latest.expectKvLatest, true);
  assert.equal(latest.expectFrom, "2026-10-31T21:42:50.000Z");
  const served = (from) => async () => ({ cert: { subject: { CN: "shop.contoso.test" }, issuer: { O: "Test CA" }, subjectaltname: "DNS:shop.contoso.test", valid_from: new Date(from).toUTCString(), valid_to: new Date(LEAF_FROM + 300 * DAY).toUTCString(), fingerprint: "AA:BB" }, authorized: true, authError: null });
  const kinds = (r) => r.findings.map((x) => x.kind);

  // The gateway already serves a newer certificate than the settings show: the renewal arrived first.
  const newer = await t.check(latest, 30, served(LEAF_FROM + 5 * DAY), LEAF_FROM + 10 * DAY);
  assert.deepEqual(kinds(newer), []);
  assert.equal(newer.live.status, "ok");
  assert.match(newer.live.note, /newer certificate/);

  // The certificate in the settings is a few hours old: the gateway has not picked it up yet.
  const fresh = await t.check(latest, 30, served(LEAF_FROM - 300 * DAY), LEAF_FROM + 3 * 3600000);
  assert.deepEqual(kinds(fresh), []);
  assert.match(fresh.live.note, /less than a day old/);

  // Days later the gateway still serves the older one: reported.
  const stuck = await t.check(latest, 30, served(LEAF_FROM - 300 * DAY), LEAF_FROM + 3 * DAY);
  assert.deepEqual(kinds(stuck), ["agw-cert-served-differs"]);
  assert.equal(stuck.live.status, "differs");

  // Pinned to one version or uploaded: no renewal to wait for, so a newer served certificate is still reported.
  const pinned = targetOf("https://kv-web.vault.azure.net/secrets/shop/0123456789abcdef");
  assert.equal(pinned.expectKvLatest, false);
  assert.deepEqual(kinds(await t.check(pinned, 30, served(LEAF_FROM + 5 * DAY), LEAF_FROM + 10 * DAY)), ["agw-cert-served-differs"]);
  assert.deepEqual(kinds(await t.check(targetOf(""), 30, served(LEAF_FROM + 5 * DAY), LEAF_FROM + 10 * DAY)), ["agw-cert-served-differs"]);
});
