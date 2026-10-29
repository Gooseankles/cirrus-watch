// What a delete-and-purge in the key vault came to, read from the vault's
// answers: purged, kept by purge protection, kept because the identity may
// not purge, or nothing was there.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { purgeOutcome } = require("../src/secretStore")._test;

after(env.cleanup);

const now = Date.parse("2026-10-29T12:00:00Z");
const inDays = (d) => Math.floor(now / 1000) + d * 86400;

test("no secret stored", () => {
  assert.deepEqual(purgeOutcome({ status: 404 }, null, now), { deleted: false, purged: false, keptDays: null, reason: "no secret was stored" });
});

test("deleted and purged", () => {
  const del = { status: 200, data: { scheduledPurgeDate: inDays(90) } };
  assert.deepEqual(purgeOutcome(del, { status: 204 }, now), { deleted: true, purged: true, keptDays: null, reason: null });
  assert.equal(purgeOutcome(del, { status: 404 }, now).purged, true, "already gone from the bin");
  assert.equal(purgeOutcome(del, null, now).purged, true);
});

test("purge protection keeps it, for as long as the vault says", () => {
  const del = { status: 200, data: { scheduledPurgeDate: inDays(90) } };
  const refused = { status: 403, data: { error: { code: "Forbidden", message: "Purge is not allowed: purge protection is enabled", innererror: { code: "ForbiddenByPolicy" } } } };
  assert.deepEqual(purgeOutcome(del, refused, now), { deleted: true, purged: false, keptDays: 90, reason: "the vault's purge protection keeps it" });
  const soon = { status: 200, data: { scheduledPurgeDate: inDays(0.2) } };
  assert.equal(purgeOutcome(soon, refused, now).keptDays, 1, "never less than a day");
  assert.equal(purgeOutcome({ status: 200, data: {} }, refused, now).keptDays, null, "no date given");
});

test("an identity without the purge right", () => {
  const del = { status: 200, data: { scheduledPurgeDate: inDays(7) } };
  const refused = { status: 403, data: { error: { code: "Forbidden", message: "The user, group or application does not have secrets purge permission on key vault" } } };
  const r = purgeOutcome(del, refused, now);
  assert.equal(r.deleted, true);
  assert.equal(r.purged, false);
  assert.equal(r.keptDays, 7);
  assert.match(r.reason, /needs Key Vault Secrets Officer/);
});

test("any other purge failure names the status", () => {
  const r = purgeOutcome({ status: 200, data: {} }, { status: 409, data: { error: { code: "Conflict" } } }, now);
  assert.deepEqual(r, { deleted: true, purged: false, keptDays: null, reason: "the purge failed (409 Conflict); the vault keeps it" });
  assert.equal(purgeOutcome({ status: 200, data: {} }, { status: 500 }, now).reason, "the purge failed (500); the vault keeps it");
});
