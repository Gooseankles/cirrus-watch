// Certificates: application gateway certificates read from the gateway's settings (PKCS#7 bundles as ARM returns
// them), Key Vault references pinned to a version and the live listener targets. Plain data in, no Azure.
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

test("live targets: public HTTPS listeners with a host name, on the public IP with the name as SNI", () => {
  const ips = new Map([["/subscriptions/s1/resourcegroups/rg-web/providers/microsoft.network/publicipaddresses/pip-agw", "20.1.2.3"]]);
  const targets = t.gatewayTargets(gateway(), ips, new Set([`${GW}/sslCertificates/shop`.toLowerCase()]));
  assert.equal(targets.length, 1, "wildcard, private and plain HTTP listeners are skipped");
  const [x] = targets;
  assert.equal(x.host, "20.1.2.3");
  assert.equal(x.port, 8443);
  assert.equal(x.sni, "shop.contoso.test");
  assert.equal(x.label, "shop.contoso.test:8443");
  assert.equal(x.skipExpiry, true);
  assert.equal(x.skipUnreachable, true);
  const unread = t.gatewayTargets(gateway(), ips, new Set());
  assert.equal(unread[0].skipExpiry, false, "expiry is checked live when the settings gave none");
});
