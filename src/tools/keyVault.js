// Key Vault posture, in four areas:
// - settings: soft delete or purge protection off, open to every network,
//   still on the access-policy model instead of Azure RBAC.
// - expiry: secrets, keys and certificates that expired, expire soon or have
//   no expiry date (metadata only; secret values are never read).
// - access: who can read secrets: secret roles granted at subscription or
//   management-group level, vaults with many readers, guests, and access
//   policies for deleted identities (deleted RBAC ones are in Role assignments).
// - logging: no diagnostic setting, no owner tag, empty or unused vaults.
//
// The control-plane checks need Reader. Listing items needs "Key Vault
// Reader" (RBAC vaults) or list permission on secrets, keys and certificates
// (access-policy vaults), and the vault's firewall must let the app in.
const axios = require("axios");
const { resourceGraphQuery, armGet } = require("../armClient");
const { graphPost } = require("../graphClient");
const { getCredential } = require("../credentials");
const settings = require("../settings");
const log = require("../log");

const TOOL_ID = "key-vault";
const VAULT_API = "7.4";
const MAX_VAULTS = 500;
const MAX_ITEMS_PER_LIST = 5000;
const CONCURRENCY = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

// Built-in roles that can read secret values, used when the role
// definitions cannot be read.
const SECRET_READ_ROLE_IDS = new Set([
  "00482a5a-887f-4fb3-b363-3b7fe8e74483", // Key Vault Administrator
  "b86a8fe4-44ce-4948-aee5-eccb2c155cd7", // Key Vault Secrets Officer
  "4633458b-17de-408a-b874-0445c86b69e6", // Key Vault Secrets User
]);

function numberSetting(key, fallback) {
  const n = Number(settings.get(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const warnDays = () => numberSetting("KEYVAULT_EXPIRY_WARN_DAYS", 30);
const maxReaders = () => numberSetting("KEYVAULT_MAX_READERS", 10);
const unusedDays = () => Math.min(numberSetting("KEYVAULT_UNUSED_DAYS", 30), 90); // metrics are kept 93 days
function ownerTag() {
  const v = String(settings.get("KEYVAULT_OWNER_TAG") || "").trim();
  if (v.toLowerCase() === "none") return null;
  return v || "Owner";
}

async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/* ---------- vault data plane ---------- */

async function vaultToken() {
  return (await getCredential(TOOL_ID).getToken("https://vault.azure.net/.default")).token;
}

async function vaultGet(url, token) {
  let response;
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true, timeout: 30000 });
    if (response.status !== 429 && response.status !== 503) break;
    const wait = Number(response.headers["retry-after"]) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
  }
  return response;
}

// All items of one kind ("secrets", "keys", "certificates"), or { error }.
async function listItems(vaultUri, kind, token) {
  const items = [];
  let url = `${vaultUri.replace(/\/?$/, "/")}${kind}?api-version=${VAULT_API}&maxresults=25`;
  while (url && items.length < MAX_ITEMS_PER_LIST) {
    let response;
    try {
      response = await vaultGet(url, token);
    } catch (err) {
      return { error: err.code === "ENOTFOUND" ? "the vault's name does not resolve (private endpoint only?)" : err.message };
    }
    if (response.status >= 300) {
      const code = response.data && response.data.error && (response.data.error.innererror?.code || response.data.error.code);
      if (code === "ForbiddenByFirewall") return { error: "the vault's firewall blocks the dashboard" };
      if (response.status === 401 || response.status === 403)
        return { error: `no permission to list ${kind} (give the shared SPN "Key Vault Reader", or list permission in the access policies)` };
      return { error: `listing ${kind} failed (${response.status}${code ? " " + code : ""})` };
    }
    items.push(...(response.data.value || []));
    url = response.data.nextLink || null;
  }
  return { items };
}

function itemName(id) {
  // https://<vault>.vault.azure.net/secrets/<name>[/<version>]
  const parts = String(id).split("/");
  const i = parts.findIndex((p) => /^(secrets|keys|certificates)$/.test(p));
  return i >= 0 ? parts[i + 1] : parts.pop();
}

/* ---------- control plane ---------- */

async function loadVaults() {
  const rows = await resourceGraphQuery(
    `Resources
     | where type =~ 'microsoft.keyvault/vaults'
     | project id, name, subscriptionId, resourceGroup, location, tags,
               vaultUri = tostring(properties.vaultUri),
               softDelete = properties.enableSoftDelete,
               purgeProtection = properties.enablePurgeProtection,
               rbac = properties.enableRbacAuthorization,
               publicNetworkAccess = tostring(properties.publicNetworkAccess),
               defaultAction = tostring(properties.networkAcls.defaultAction),
               privateEndpoints = array_length(properties.privateEndpointConnections),
               accessPolicies = properties.accessPolicies
     | order by id asc`,
    { toolId: TOOL_ID }
  );
  if (rows.length > MAX_VAULTS) {
    log.record({ tool: TOOL_ID, level: "info", message: `${rows.length} vaults found; checking the first ${MAX_VAULTS}` });
  }
  return rows.slice(0, MAX_VAULTS);
}

// Which role definition IDs (last path part, lower case) can read secret values.
async function secretReadRoles() {
  try {
    const defs = await resourceGraphQuery(
      `AuthorizationResources
       | where type =~ 'microsoft.authorization/roledefinitions'
       | project id = tolower(id), roleName = tostring(properties.roleName), permissions = properties.permissions`,
      { toolId: TOOL_ID, subscriptions: [] }
    );
    const grants = (a) => {
      const s = String(a).toLowerCase();
      return ["*", "microsoft.keyvault/*", "microsoft.keyvault/vaults/*", "microsoft.keyvault/vaults/secrets/*", "microsoft.keyvault/vaults/secrets/getsecret/action"].includes(s);
    };
    const ids = new Map();
    for (const d of defs) {
      const perms = Array.isArray(d.permissions) ? d.permissions : [];
      const can = perms.some(
        (p) =>
          (p.dataActions || []).some(grants) &&
          !(p.notDataActions || []).some((n) => /secrets\/(\*|getsecret\/action)$|^microsoft\.keyvault\/(vaults\/)?\*$/i.test(n))
      );
      if (can) ids.set(d.id.split("/").pop(), d.roleName);
    }
    if (ids.size) return ids;
  } catch (err) {
    log.record({ tool: TOOL_ID, level: "info", message: `could not read role definitions, using the built-in Key Vault roles: ${err.message}` });
  }
  return new Map([...SECRET_READ_ROLE_IDS].map((id) => [id, null]));
}

async function secretRoleAssignments(roleIds) {
  const rows = await resourceGraphQuery(
    `AuthorizationResources
     | where type =~ 'microsoft.authorization/roleassignments'
     | extend roleId = tolower(tostring(split(tostring(properties.roleDefinitionId), '/')[-1]))
     | project id, roleId, scope = tostring(properties.scope),
               principalId = tolower(tostring(properties.principalId)),
               principalType = tostring(properties.principalType)`,
    { toolId: TOOL_ID }
  );
  return rows.filter((r) => roleIds.has(r.roleId));
}

// subscription ID -> management group names above it
async function managementGroupChains() {
  const rows = await resourceGraphQuery(
    `ResourceContainers
     | where type =~ 'microsoft.resources/subscriptions'
     | project subscriptionId, chain = properties.managementGroupAncestorsChain`,
    { toolId: TOOL_ID }
  ).catch(() => []);
  return new Map(rows.map((r) => [r.subscriptionId, new Set((r.chain || []).map((m) => String(m.name).toLowerCase()))]));
}

function scopeCovers(scope, vault, mgChains) {
  const s = String(scope || "").toLowerCase().replace(/\/$/, "");
  if (s === "" || s === "/") return true;
  const mg = s.match(/^\/providers\/microsoft\.management\/managementgroups\/([^/]+)$/);
  if (mg) return Boolean(mgChains.get(vault.subscriptionId)?.has(mg[1]));
  const id = vault.id.toLowerCase();
  return id === s || id.startsWith(s + "/");
}

function scopeText(scope) {
  const s = scope || "";
  const mg = s.match(/managementGroups\/([^/]+)$/i);
  if (mg) return `management group ${mg[1]}`;
  if (s === "/") return "tenant root";
  if (/^\/subscriptions\/[^/]+\/?$/i.test(s)) return "whole subscription";
  return s
    .replace(/^\/subscriptions\/[^/]+/i, "")
    .replace(/^\/resourceGroups\/([^/]+)\/providers\/Microsoft\.KeyVault\/vaults\/([^/]+)$/i, "vault $2")
    .replace(/^\/resourceGroups\//i, "rg ");
}

// object ID -> { name, type, guest } for the ones that exist
async function lookupPrincipals(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const page = await graphPost(
      "/directoryObjects/getByIds",
      { ids: ids.slice(i, i + 1000), types: ["user", "group", "servicePrincipal"] },
      TOOL_ID
    );
    for (const o of page.value || []) {
      const type = String(o["@odata.type"] || "").replace("#microsoft.graph.", "");
      found.set(String(o.id).toLowerCase(), {
        name: o.displayName || o.userPrincipalName || o.id,
        upn: o.userPrincipalName || null,
        type,
        guest: type === "user" && (o.userType === "Guest" || /#EXT#/i.test(o.userPrincipalName || "")),
      });
    }
  }
  return found;
}

async function hasDiagnostics(vault) {
  const data = await armGet(`https://management.azure.com${vault.id}/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview`, TOOL_ID);
  return (data.value || []).length > 0;
}

// API hits in the last N days other than listing (the scans themselves list
// items, so counting those would make every vault look used).
async function realApiHits(vault, days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * DAY_MS);
  const url =
    `https://management.azure.com${vault.id}/providers/Microsoft.Insights/metrics?api-version=2018-01-01` +
    `&metricnames=ServiceApiHit&aggregation=Total&interval=P1D&timespan=${start.toISOString()}/${end.toISOString()}` +
    `&$filter=${encodeURIComponent("ActivityName eq '*'")}`;
  const data = await armGet(url, TOOL_ID);
  let hits = 0;
  for (const series of data.value?.[0]?.timeseries || []) {
    const name = String((series.metadatavalues || []).find((m) => /activityname/i.test(m.name?.value || ""))?.value || "").toLowerCase();
    if (name.includes("list")) continue;
    for (const d of series.data || []) hits += d.total || 0;
  }
  return hits;
}

/* ---------- run ---------- */

async function run() {
  const vaults = await loadVaults();
  const findings = [];
  const add = (vault, f) =>
    findings.push({
      subscriptionId: vault ? vault.subscriptionId : null,
      resourceGroup: vault ? vault.resourceGroup : null,
      vault: vault ? vault.name : null,
      ...f,
    });

  // --- settings ---
  for (const v of vaults) {
    if (v.softDelete === false) {
      add(v, { area: "settings", kind: "kv-soft-delete-off", id: v.id, name: v.name, detail: "soft delete is off: a deleted secret, key or certificate is gone at once" });
    }
    if (v.purgeProtection !== true) {
      add(v, { area: "settings", kind: "kv-purge-protection-off", id: v.id, name: v.name, detail: "purge protection is off: deleted items can be purged before the retention period ends (it cannot be turned off again once on)" });
    }
    if (String(v.publicNetworkAccess).toLowerCase() !== "disabled" && String(v.defaultAction).toLowerCase() !== "deny") {
      add(v, { area: "settings", kind: "kv-public-network", id: v.id, name: v.name, detail: `reachable from every network (public access on, firewall default Allow${v.privateEndpoints ? `, ${v.privateEndpoints} private endpoint(s) too` : ""})` });
    }
    if (v.rbac !== true) {
      add(v, { area: "settings", kind: "kv-access-policies", id: v.id, name: v.name, detail: `uses vault access policies (${(v.accessPolicies || []).length}) instead of Azure RBAC; anyone with Contributor on the vault can give themselves access` });
    }
    const tag = ownerTag();
    if (tag && !Object.keys(v.tags || {}).some((k) => k.toLowerCase() === tag.toLowerCase())) {
      add(v, { area: "logging", kind: "kv-no-owner-tag", id: v.id, name: v.name, detail: `no "${tag}" tag: nobody to ask about this vault` });
    }
  }

  // --- expiry, empty vaults, diagnostics, usage (per vault) ---
  const token = await vaultToken().catch((err) => {
    log.record({ tool: TOOL_ID, level: "error", message: `no Key Vault token, skipping item checks: ${err.message}` });
    return null;
  });
  const now = Date.now();
  const warnMs = warnDays() * DAY_MS;
  const days = unusedDays();
  let listed = 0;
  let diagErrors = 0;
  let metricErrors = 0;

  await pool(vaults, CONCURRENCY, async (v) => {
    try {
      if (!(await hasDiagnostics(v))) {
        add(v, { area: "logging", kind: "kv-no-diagnostics", id: v.id, name: v.name, detail: "no diagnostic setting: reads and changes of secrets are not logged anywhere" });
      }
    } catch {
      diagErrors++;
    }

    let total = 0;
    let blocked = null;
    if (token && v.vaultUri) {
      for (const kind of ["secrets", "keys", "certificates"]) {
        const res = await listItems(v.vaultUri, kind, token);
        if (res.error) {
          blocked = res.error;
          break;
        }
        for (const item of res.items) {
          const a = item.attributes || {};
          // Certificate-backed secrets and keys are covered by the certificate itself.
          if (item.managed || a.enabled === false) continue;
          total++;
          const type = kind.slice(0, -1);
          const name = `${v.name}/${itemName(item.id || item.kid)}`;
          const id = `${v.id}/${kind}/${itemName(item.id || item.kid)}`.toLowerCase();
          if (!a.exp) {
            if (kind !== "certificates") add(v, { area: "expiry", kind: "kv-no-expiry", id, name, itemType: type, detail: `${type} has no expiry date` });
            continue;
          }
          const expMs = a.exp * 1000;
          const expIso = new Date(expMs).toISOString();
          if (expMs <= now) {
            add(v, { area: "expiry", kind: "kv-expired", id, name, itemType: type, expires: expIso, detail: `${type} expired ${expIso.slice(0, 10)} (${Math.floor((now - expMs) / DAY_MS)} days ago)` });
          } else if (expMs - now <= warnMs) {
            add(v, { area: "expiry", kind: "kv-expiring", id, name, itemType: type, expires: expIso, detail: `${type} expires ${expIso.slice(0, 10)} (in ${Math.ceil((expMs - now) / DAY_MS)} days)` });
          }
        }
      }
      if (blocked) {
        add(v, { area: "expiry", kind: "kv-no-data-access", id: v.id, name: v.name, detail: `items not checked: ${blocked}` });
      } else {
        listed++;
        if (total === 0) add(v, { area: "logging", kind: "kv-empty", id: v.id, name: v.name, detail: "no enabled secrets, keys or certificates" });
      }
    }

    if (total > 0 || blocked) {
      try {
        if ((await realApiHits(v, days)) === 0) {
          add(v, { area: "logging", kind: "kv-unused", id: v.id, name: v.name, detail: `no reads or writes in the last ${days} days (listing not counted)` });
        }
      } catch {
        metricErrors++;
      }
    }
  });

  // --- access ---
  const readers = new Map(vaults.map((v) => [v.id, new Map()])); // vault id -> principalId -> how
  const roleIds = await secretReadRoles();
  let assignments = [];
  try {
    assignments = await secretRoleAssignments(roleIds);
  } catch (err) {
    log.record({ tool: TOOL_ID, level: "error", message: `could not read role assignments: ${err.message}` });
  }
  const mgChains = assignments.some((a) => /managementgroups/i.test(a.scope)) ? await managementGroupChains() : new Map();
  const rbacVaults = vaults.filter((v) => v.rbac === true);
  for (const a of assignments) {
    const covered = rbacVaults.filter((v) => scopeCovers(a.scope, v, mgChains));
    for (const v of covered) readers.get(v.id).set(a.principalId, { via: `${roleIds.get(a.roleId) || "secret role"} on ${scopeText(a.scope)}`, type: a.principalType });
    const broad = /managementgroups|^\/$|^\/subscriptions\/[^/]+\/?$/i.test(a.scope);
    if (broad && covered.length) {
      const sub = (a.scope.match(/^\/subscriptions\/([^/]+)/i) || [])[1] || null;
      add(null, {
        area: "access",
        kind: "kv-broad-secret-access",
        id: a.id,
        name: `${roleIds.get(a.roleId) || "Secret-reading role"} on ${scopeText(a.scope)}`,
        subscriptionId: sub,
        principalId: a.principalId,
        principalType: a.principalType,
        detail: `can read the secrets of every vault below it (${covered.length} RBAC vault(s) now); grant it per vault instead`,
      });
    }
  }
  for (const v of vaults.filter((x) => x.rbac !== true)) {
    for (const p of v.accessPolicies || []) {
      const secrets = ((p.permissions && p.permissions.secrets) || []).map((s) => String(s).toLowerCase());
      if (!secrets.some((s) => s === "get" || s === "all")) continue;
      readers.get(v.id).set(String(p.objectId).toLowerCase(), { via: "access policy", policy: true });
    }
  }

  const ids = [...new Set([...readers.values()].flatMap((m) => [...m.keys()]))];
  let principals = null;
  try {
    principals = await lookupPrincipals(ids);
    const missing = ids.filter((id) => !principals.has(id)).length;
    if (ids.length > 20 && missing / ids.length > 0.5) {
      log.record({ tool: TOOL_ID, level: "error", message: `${missing} of ${ids.length} principals not found in Entra; missing Graph permissions more likely than deleted identities, so deleted and guest checks were skipped` });
      principals = null;
    }
  } catch (err) {
    log.record({ tool: TOOL_ID, level: "error", message: `could not look up principals, deleted and guest checks skipped: ${err.message}` });
  }

  for (const v of vaults) {
    const who = readers.get(v.id);
    if (who.size > maxReaders()) {
      const groups = [...who].filter(([pid, w]) => /group/i.test(w.type || "") || (principals && principals.get(pid)?.type === "group")).length;
      add(v, { area: "access", kind: "kv-many-readers", id: v.id, name: v.name, count: who.size, detail: `${who.size} identities can read secrets${groups ? ` (groups count as one)` : ""}; limit set to ${maxReaders()}` });
    }
    if (!principals) continue;
    for (const [pid, how] of who) {
      const p = principals.get(pid);
      if (!p) {
        if (how.policy) add(v, { area: "access", kind: "kv-deleted-principal", id: `${v.id}/policy/${pid}`, name: v.name, principalId: pid, detail: `access policy for object ${pid}, which no longer exists in Entra; safe to remove` });
        continue;
      }
      if (p.guest) {
        add(v, { area: "access", kind: "kv-guest-access", id: `${v.id}/guest/${pid}`, name: `${v.name}: ${p.name}`, principalId: pid, detail: `guest ${p.name} can read secrets (${how.via})` });
      }
    }
  }

  log.record({
    tool: TOOL_ID,
    level: "info",
    message:
      `${vaults.length} vault(s), items listed in ${listed}` +
      (diagErrors ? `, diagnostic settings unreadable for ${diagErrors}` : "") +
      (metricErrors ? `, usage metrics unreadable for ${metricErrors}` : ""),
  });
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Key Vault",
  schedule: "45 5 * * *", // nightly at 05:45
  run,
};
