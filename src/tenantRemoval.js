// Removing a customer tenant for good (Settings, Remove): everything the
// dashboard holds for it goes, nothing is kept. In this order, each step on
// its own so one that fails does not stop the rest:
//   1. the tenant entry (tenants.forget): from here on it is not listed,
//      scanned or written to, and a scan still running cannot make its store
//      again (findingsStore drops writes for a tenant that no longer exists)
//   2. its client secret: purged from the key vault's bin too, or gone with
//      the entry when tenants.json held it
//   3. its notification link (also a secret) and what was waiting to be sent
//   4. its store: the blob container or the DATA_DIR/tenants/<key> folder
//      (results, history, accepted findings, cost history, savings)
//   5. its own settings (tenant-settings.json)
//   6. cached subscription names and the cached sign-in with its secret
//   7. its lines in the activity log
// The audit log keeps who removed which tenant and when (server.js).
//
// What the app cannot delete: the customer's Entra roles and groups, which
// Terraform made (the app has no write permission in Entra), and the customer's
// own app registration. A Terraform tenant stays in DASHBOARD_TENANTS until it
// is removed there too; meanwhile its key is on the removed list and the
// tenant is ignored. deps is for tests: each module can be stood in for.
const defaults = {
  tenants: require("./tenants"),
  findingsStore: require("./findingsStore"),
  notify: require("./notify"),
  secretStore: require("./secretStore"),
  settings: require("./settings"),
  log: require("./log"),
  armClient: require("./armClient"),
  credentials: require("./credentials"),
};
const { HOME } = require("./tenantContext");

const LABELS = {
  tenant: "tenant entry",
  secret: "client secret",
  notify: "notification link and queue",
  store: "results, history, accepted findings and cost history",
  settings: "tenant settings",
  caches: "cached names and sign-in",
  log: "activity log lines",
};

// The vault's answer in one line, for the result and the audit log.
function secretText(outcome) {
  if (!outcome.deleted) return outcome.reason;
  if (outcome.purged) return "deleted and purged from the key vault";
  const days = outcome.keptDays ? ` for ${outcome.keptDays} day${outcome.keptDays === 1 ? "" : "s"}` : "";
  return `deleted; ${outcome.reason}${days}`;
}

// key: the tenant's key; by: who asked (for the removed list). Resolves to
// { key, name, terraform, deleted: [{ step, label, detail }], failed: [{ step,
// label, error }], kept: [text], message }. Throws only when there is nothing
// to remove: the home tenant, an unknown key.
async function removeEverything(key, { by } = {}, deps = defaults) {
  const k = String(key || "").trim().toLowerCase();
  if (!k || k === HOME) throw new Error("the home tenant cannot be removed");
  const t = deps.tenants.byKey(k);
  if (!t || t.home) throw new Error("no such tenant");
  const deleted = [];
  const failed = [];
  const kept = [];
  const step = async (id, fn) => {
    try {
      const detail = await fn();
      deleted.push({ step: id, label: LABELS[id], detail: detail || null });
    } catch (err) {
      failed.push({ step: id, label: LABELS[id], error: String(err.message || err).slice(0, 300) });
    }
  };

  let terraform = false;
  let fileSecret = false;
  await step("tenant", () => {
    const r = deps.tenants.forget(k, by);
    terraform = r.terraform;
    fileSecret = r.fileSecret;
    return terraform ? "removed from the list; ignored until Terraform drops it too" : "removed from the list";
  });

  await step("secret", async () => {
    if (deps.secretStore.enabled()) {
      const outcome = await deps.secretStore.purge("tenant", k);
      if (outcome.deleted && !outcome.purged) kept.push(`The client secret is ${secretText(outcome)}.`);
      return secretText(outcome);
    }
    return fileSecret ? "went with the tenant entry (tenants.json)" : "none was stored";
  });

  await step("notify", async () => {
    const outcome = await deps.notify.drop(k, { purge: true });
    if (!outcome) return "removed";
    if (outcome.deleted && !outcome.purged) kept.push(`The notification link is ${secretText(outcome)}.`);
    return secretText(outcome);
  });

  await step("store", async () => {
    const r = await deps.findingsStore.deleteTenantStore(k);
    const what = r.backend === "blob" ? `container ${r.where}` : `folder ${r.where}`;
    return r.existed ? `${what} deleted` : `${what} did not exist`;
  });

  await step("settings", () => (deps.settings.dropTenant(k) ? "removed" : "none were set"));

  await step("caches", () => {
    const names = deps.armClient.forgetTenant(k);
    const creds = t.tenantId && t.clientId ? deps.credentials.forget(t.tenantId, t.clientId) : 0;
    return `${names} cached name list(s), ${creds} cached sign-in(s)`;
  });

  await step("log", () => `${deps.log.dropTenant(k)} line(s) removed`);

  return { key: k, name: t.name, terraform, deleted, failed, kept, message: message({ key: k, terraform, failed, kept }) };
}

// What the Settings page shows after a Remove.
function message({ key, terraform, failed, kept }) {
  const parts = [];
  if (failed.length) {
    parts.push(`Removed from Cirrus Watch, but not everything could be deleted: ${failed.map((f) => `${f.label} (${f.error})`).join("; ")}. Finish that by hand.`);
  } else {
    parts.push("Removed from Cirrus Watch.");
  }
  parts.push(...kept);
  if (terraform) parts.push(`Also remove "${key}" from customers in Terraform and apply: that deletes its roles and groups.`);
  return parts.join(" ");
}

// One line for the audit log: what went and what did not. Never a secret.
function summary(r) {
  const went = r.deleted.map((d) => `${d.label}: ${d.detail || "removed"}`);
  const not = r.failed.map((f) => `${f.label} FAILED: ${f.error}`);
  return [...went, ...not].join(" | ");
}

module.exports = { removeEverything, summary, LABELS };
