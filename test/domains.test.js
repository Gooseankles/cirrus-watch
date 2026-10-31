// The Domains and mail scan: registrable domains, SPF parsing and lookup counting,
// DMARC parsing, RDAP expiry and lock, App Service Domains and zone delegation.
// Plain data in, no Azure and no network.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const d = require("../src/tools/domains")._test;

after(env.cleanup);

test("registrable domain: plain, multi-part suffixes, Microsoft names and bad input", () => {
  assert.equal(d.registrableDomain("www.Shop.Example.com."), "example.com");
  assert.equal(d.registrableDomain("example.com"), "example.com");
  assert.equal(d.registrableDomain("mail.example.co.uk"), "example.co.uk");
  assert.equal(d.registrableDomain("a.b.example.com.au"), "example.com.au");
  assert.equal(d.registrableDomain("ola.priv.no"), "ola.priv.no");
  assert.equal(d.registrableDomain("firma.no"), "firma.no");
  assert.equal(d.registrableDomain("*.example.org"), "example.org");
  assert.equal(d.registrableDomain("co.uk"), null);
  assert.equal(d.registrableDomain("contoso.onmicrosoft.com"), null);
  assert.equal(d.registrableDomain("contoso.mail.onmicrosoft.com"), null);
  assert.equal(d.registrableDomain("app1.azurewebsites.net"), null);
  assert.equal(d.registrableDomain("localhost"), null);
  assert.equal(d.registrableDomain("10.0.0.1"), null);
  assert.equal(d.registrableDomain(""), null);
});

test("user domains: member UPNs and SMTP addresses, guests and onmicrosoft left out", () => {
  const got = d.domainsFromUsers([
    { userPrincipalName: "ann@contoso.com", proxyAddresses: ["SMTP:ann@contoso.com", "smtp:ann@sales.contoso.com", "SIP:ann@contoso.com", "smtp:ann@contoso.onmicrosoft.com"] },
    { userPrincipalName: "bob_fabrikam.com#EXT#@contoso.onmicrosoft.com", proxyAddresses: ["SMTP:bob@fabrikam.com"] },
    { userPrincipalName: "svc@contoso.onmicrosoft.com" },
  ]);
  assert.deepEqual([...got].sort(), ["contoso.com", "sales.contoso.com"]);
});

test("SPF parsing: all qualifier, lookups, includes and redirect", () => {
  const p = d.parseSpf("v=spf1 ip4:192.0.2.0/24 include:spf.protection.outlook.com include:_spf.google.com a mx ~all");
  assert.equal(p.all, "~");
  assert.equal(p.lookups, 4);
  assert.deepEqual(p.follow, ["spf.protection.outlook.com", "_spf.google.com"]);
  assert.equal(d.parseSpf("v=spf1 +all").all, "+");
  assert.equal(d.parseSpf("v=spf1 all").all, "+");
  assert.equal(d.parseSpf("v=spf1 mx ?all").all, "?");
  const r = d.parseSpf("v=spf1 redirect=_spf.example.com");
  assert.equal(r.all, null);
  assert.equal(r.redirect, "_spf.example.com");
  assert.equal(r.lookups, 1);
  assert.deepEqual(r.follow, ["_spf.example.com"]);
  // A redirect next to "all" is ignored; a macro is counted but not followed; ip4/ip6 cost nothing.
  const both = d.parseSpf("v=spf1 exists:%{i}.x.example.com ptr ip6:2001:db8::/32 -all redirect=other.example.com");
  assert.equal(both.all, "-");
  assert.equal(both.redirect, null);
  assert.deepEqual(both.follow, []);
  assert.equal(both.lookups, 3);
  assert.deepEqual(d.spfRecords(["v=spf1 -all", "google-site-verification=x", "v=spf10 x", "V=SPF1 mx"]), ["v=spf1 -all", "V=SPF1 mx"]);
  assert.deepEqual(d.txtRecords([["v=spf1 include:a", ".example.com -all"], ["x"]]), ["v=spf1 include:a.example.com -all", "x"]);
});

test("SPF lookup counting follows includes, notes missing ones and stops on loops", async () => {
  const records = {
    "a.example.com": "v=spf1 include:b.example.com mx a -all",
    "b.example.com": "v=spf1 include:c.example.com include:a.example.com -all",
    "c.example.com": "v=spf1 a mx ptr exists:x.example.com -all",
  };
  const get = async (n) => records[n] || null;
  const r = await d.countSpfLookups("v=spf1 include:a.example.com include:gone.example.com mx -all", get, 0, new Set(["example.com"]));
  // top 3 + a 3 + b 2 + c 4 = 12
  assert.equal(r.count, 12);
  assert.ok(r.problems.some((p) => p.includes("gone.example.com has no SPF record")));
  assert.ok(r.problems.some((p) => p.includes("loop through a.example.com")));
  const small = await d.countSpfLookups("v=spf1 include:c.example.com -all", get);
  assert.equal(small.count, 5);
  assert.deepEqual(small.problems, []);
});

test("DMARC parsing", () => {
  assert.deepEqual(
    (({ valid, p, sp }) => ({ valid, p, sp }))(d.parseDmarc("v=DMARC1; p=Quarantine; sp=none; rua=mailto:d@example.com")),
    { valid: true, p: "quarantine", sp: "none" }
  );
  assert.equal(d.parseDmarc("v=DMARC1;p=none").p, "none");
  assert.equal(d.parseDmarc("v=DMARC1; rua=mailto:x@example.com").valid, false);
  assert.equal(d.parseDmarc("v=DMARC1; p=bogus").valid, false);
  assert.equal(d.parseDmarc("v=spf1 -all").valid, false);
  assert.equal(d.parseDmarc("").valid, false);
});

test("RDAP summary: expiry, transfer lock, registrar", () => {
  const s = d.rdapSummary({
    events: [{ eventAction: "registration", eventDate: "1991-05-02T04:00:00Z" }, { eventAction: "expiration", eventDate: "2027-05-03T04:00:00Z" }],
    status: ["client delete prohibited", "client transfer prohibited"],
    entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "MarkMonitor Inc."]]] }],
  });
  assert.equal(s.expires, "2027-05-03T04:00:00.000Z");
  assert.equal(s.locked, true);
  assert.equal(s.registrar, "MarkMonitor Inc.");
  assert.equal(d.rdapSummary({ status: ["serverTransferProhibited"] }).locked, true);
  assert.equal(d.rdapSummary({ status: ["active"] }).locked, false);
  // .no-style reply: no expiry, no status -> unknown, not a finding.
  const none = d.rdapSummary({ events: [{ eventAction: "registration", eventDate: "2001-01-01" }] });
  assert.equal(none.expires, null);
  assert.equal(none.locked, null);
  assert.deepEqual(d.rdapFindings("firma.no", none), []);
});

test("expiry kinds and RDAP findings", () => {
  assert.equal(d.expiryKind(-1), "domain-expired");
  assert.equal(d.expiryKind(0), "domain-expiring");
  assert.equal(d.expiryKind(29), "domain-expiring");
  assert.equal(d.expiryKind(30), "domain-renewal-due");
  assert.equal(d.expiryKind(59), "domain-renewal-due");
  assert.equal(d.expiryKind(60), null);
  const soon = new Date(Date.now() + 10 * 86400000).toISOString();
  const f = d.rdapFindings("example.com", { expires: soon, statuses: ["active"], locked: false, registrar: null });
  assert.deepEqual(f.map((x) => x.kind).sort(), ["domain-expiring", "domain-unlocked"]);
  assert.equal(f.find((x) => x.kind === "domain-expiring").id, "domains/example.com#domain-expiring");
  // Lock check only under generic TLDs; expiry skipped when the App Service Domain check covers it.
  assert.deepEqual(d.rdapFindings("example.de", { expires: null, statuses: ["active"], locked: false }), []);
  assert.deepEqual(d.rdapFindings("example.com", { expires: soon, statuses: [], locked: null }, { skipExpiry: true }), []);
});

test("App Service Domains: expiry and auto-renew", () => {
  const base = { id: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.DomainRegistration/domains/example.com", name: "example.com", resourceGroup: "rg", subscriptionId: "s1" };
  const later = new Date(Date.now() + 200 * 86400000).toISOString();
  const soon = new Date(Date.now() + 40 * 86400000).toISOString();
  assert.deepEqual(d.judgeAppServiceDomain({ ...base, expirationTime: later, autoRenew: true, status: "Active" }), []);
  assert.deepEqual(d.judgeAppServiceDomain({ ...base, expirationTime: later, autoRenew: false, status: "Active" }).map((f) => f.kind), ["asd-auto-renew-off"]);
  const f = d.judgeAppServiceDomain({ ...base, expirationTime: soon, autoRenew: "true", status: "Active" });
  assert.deepEqual(f.map((x) => x.kind), ["domain-renewal-due"]);
  assert.equal(f[0].subscriptionId, "s1");
});

test("zone delegation comparison", () => {
  const azure = ["ns1-01.azure-dns.com.", "ns2-01.azure-dns.net.", "ns3-01.azure-dns.org.", "ns4-01.azure-dns.info."];
  assert.equal(d.compareDelegation(azure, ["NS4-01.azure-dns.info", "ns3-01.azure-dns.org", "ns2-01.azure-dns.net", "ns1-01.azure-dns.com"]), null);
  assert.deepEqual(d.compareDelegation(azure, []).missing.length, 4);
  assert.deepEqual(d.compareDelegation(azure, ["ns1.registrar.example"]).extra, ["ns1.registrar.example"]);
  assert.equal(d.compareDelegation([], ["x"]), null);
});
