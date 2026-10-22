// Missing safety nets: subscriptions without a cost budget (or with one that
// tells nobody), and key resources a single click can delete because no delete
// or read-only lock covers them (on the resource, its resource group or its
// subscription). Reader is enough.
const { resourceGraphQuery, armGet, subscriptionIdsToScan } = require("../armClient");
const settings = require("../settings");
const { mapLimit, itemErrors, runChecks } = require("./util");

const TOOL_ID = "safety-nets";
const CONCURRENCY = 6;
const ARM = "https://management.azure.com";
const DEFAULT_LOCK_TYPES = [
  "microsoft.keyvault/vaults",
  "microsoft.recoveryservices/vaults",
  "microsoft.dataprotection/backupvaults",
  "microsoft.network/virtualnetworks",
  "microsoft.network/dnszones",
  "microsoft.network/privatednszones",
];

async function pages(url) {
  const out = [];
  while (url) {
    const page = await armGet(url, TOOL_ID);
    out.push(...(page.value || []));
    url = page.nextLink || null;
  }
  return out;
}

async function budgets() {
  const subs = await subscriptionIdsToScan(TOOL_ID);
  const findings = [];
  const failures = await mapLimit(subs.map((subscriptionId) => ({ subscriptionId })), CONCURRENCY, async ({ subscriptionId }) => {
    const list = await pages(`${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Consumption/budgets?api-version=2023-05-01`);
    if (!list.length) {
      findings.push({
        kind: "no-budget",
        id: `/subscriptions/${subscriptionId}/budgets`,
        name: "No budget",
        subscriptionId,
        detail: "No cost budget on this subscription, so nobody hears about overspend until the invoice. Add one in Cost Management, Budgets, with an alert",
      });
      return;
    }
    const alerting = list.filter((b) => Object.values((b.properties && b.properties.notifications) || {}).some((n) => n && n.enabled && ((n.contactEmails || []).length || (n.contactGroups || []).length || (n.contactRoles || []).length)));
    if (!alerting.length) {
      findings.push({
        kind: "budget-no-alerts",
        id: `/subscriptions/${subscriptionId}/budgets`,
        name: list.length === 1 ? list[0].name : `${list.length} budgets`,
        subscriptionId,
        detail: "Budget set, but no alert is on with someone to tell (emails, action group or role), so it warns nobody",
      });
    }
  });
  if (subs.length && failures.length === subs.length) throw new Error(`every budget list failed, e.g. ${failures[0].message}`);
  return [...findings, ...itemErrors(TOOL_ID, "budgets", "subscriptions' budgets", failures, subs.length)];
}

function lockTypes() {
  const raw = String(settings.get("LOCK_RESOURCE_TYPES") || "").trim().toLowerCase();
  if (raw === "none") return [];
  if (!raw) return DEFAULT_LOCK_TYPES;
  return raw.split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9.]+\/[a-z0-9./]+$/.test(s));
}

async function locks() {
  const types = lockTypes();
  if (!types.length) return [];
  const resources = await resourceGraphQuery(
    `Resources
    | where type in~ (${types.map((t) => `'${t}'`).join(", ")})
    | project id, name, type, resourceGroup, subscriptionId`,
    { toolId: TOOL_ID }
  );
  const subs = [...new Set(resources.map((r) => r.subscriptionId))];
  // Each subscription's locks at every level, as the scopes they cover.
  const scopes = new Map();
  const failures = await mapLimit(subs.map((subscriptionId) => ({ subscriptionId })), CONCURRENCY, async ({ subscriptionId }) => {
    const list = await pages(`${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/locks?api-version=2020-05-01`);
    scopes.set(subscriptionId, list.map((l) => String(l.id || "").toLowerCase().split("/providers/microsoft.authorization/locks/")[0]).filter(Boolean));
  });
  const findings = [];
  for (const r of resources) {
    const covered = scopes.get(r.subscriptionId);
    if (!covered) continue; // that subscription's locks could not be read
    const id = String(r.id).toLowerCase();
    if (covered.some((s) => id === s || id.startsWith(`${s}/`))) continue;
    findings.push({
      kind: "no-delete-lock",
      id: r.id,
      name: r.name,
      resourceGroup: r.resourceGroup || null,
      subscriptionId: r.subscriptionId,
      detail: `${r.type.split("/").pop()} with no delete lock on it, its resource group or its subscription. Add a CanNotDelete lock`,
    });
  }
  if (subs.length && failures.length === subs.length) throw new Error(`every lock list failed, e.g. ${failures[0].message}`);
  return [...findings, ...itemErrors(TOOL_ID, "locks", "subscriptions' locks", failures, subs.length)];
}

async function run() {
  return runChecks(TOOL_ID, { Budgets: budgets, "Delete locks": locks });
}

module.exports = {
  id: TOOL_ID,
  label: "Safety nets",
  schedule: "50 6 * * *", // daily at 06:50
  run,
};
