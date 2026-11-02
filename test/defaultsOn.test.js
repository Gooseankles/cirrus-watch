// Checks that are on unless turned off (0.70): blank runs them, off/no/false/0
// stops them. Seen through what the Key Vault scan says it needs. No Azure.
const { test, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { NEEDS } = require("../src/toolPermissions");

after(env.cleanup);
afterEach(() => {
  delete process.env.KEYVAULT_ITEM_CHECK;
});

const needsVaultReader = () => NEEDS["key-vault"].azure.some((r) => /Key Vault Reader/.test(r));

test("the Key Vault item check is on when blank and with old spellings of yes", () => {
  assert.ok(needsVaultReader(), "blank = on");
  for (const v of ["on", "yes", "true", "1"]) {
    process.env.KEYVAULT_ITEM_CHECK = v;
    assert.ok(needsVaultReader(), v);
  }
});

test("off, no, false or 0 turns the Key Vault item check off", () => {
  for (const v of ["off", "No", "false", "0"]) {
    process.env.KEYVAULT_ITEM_CHECK = v;
    assert.ok(!needsVaultReader(), v);
  }
});
