// Checks that Azure Policy actually works, not just what it reports.
//
// 1. Probes: asks Azure "would this resource be allowed here?" for each
//    subscription (Microsoft.PolicyInsights/checkPolicyRestrictions; nothing is
//    created). A risky resource that no Deny policy blocks is a finding.
// 2. Health: assignments that cannot do anything — enforcement turned off,
//    effect resolved to Disabled, definition deleted, deploy/modify policies
//    whose identity is missing or lacks the roles its remediation needs,
//    remediation that failed or never ran, assignments that evaluate no
//    resources at all — and exemptions that never expire or have lapsed.
const { resourceGraphQuery, armGet, armPost, subscriptionIdsToScan } = require("../armClient");
const settings = require("../settings");
const log = require("../log");
const { scanError } = require("./util");

const TOOL_ID = "policy-check";
const CONCURRENCY = 4;
const MAX_DEFINITIONS = 800; // initiatives like the security benchmark hold hundreds
const DAY = 24 * 60 * 60 * 1000;

const ROLE_NAMES = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
  "92aaf0da-9dab-42b6-94a3-d43ce8d16293": "Log Analytics Contributor",
  "749f88d5-cbae-40b8-bcfc-e573ddc772fa": "Monitoring Contributor",
  "4d97b98b-1d4f-4787-a291-c67834d212e7": "Network Contributor",
  "9980e02c-c2be-4d73-94e8-173b1dc7cf3c": "Virtual Machine Contributor",
  "17d1049b-9a84-46fb-8f53-869881c3d3ab": "Storage Account Contributor",
  "4a9ae827-6dc8-4573-8ac7-8239d42aa03f": "Tag Contributor",
};
const OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
const CONTRIBUTOR = "b24988ac-6180-42a0-ab88-20f7382dd24c";
const UAA = "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9";

// --- Probes ---
// Each is a resource most organisations mean to forbid. A probe only says
// "nothing stops this"; turn off the ones you allow on purpose (POLICY_PROBES).
const PROBES = [
  {
    id: "storage-public-blob",
    label: "Storage account with public blob access",
    type: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
    content: { kind: "StorageV2", sku: { name: "Standard_LRS" }, properties: { allowBlobPublicAccess: true, supportsHttpsTrafficOnly: true, minimumTlsVersion: "TLS1_2" } },
  },
  {
    id: "storage-http",
    label: "Storage account accepting plain HTTP",
    type: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
    content: { kind: "StorageV2", sku: { name: "Standard_LRS" }, properties: { allowBlobPublicAccess: false, supportsHttpsTrafficOnly: false, minimumTlsVersion: "TLS1_2" } },
  },
  {
    id: "storage-old-tls",
    label: "Storage account allowing TLS 1.0",
    type: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
    content: { kind: "StorageV2", sku: { name: "Standard_LRS" }, properties: { allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: "TLS1_0" } },
  },
  {
    id: "public-ip",
    label: "Public IP address",
    type: "Microsoft.Network/publicIPAddresses",
    apiVersion: "2023-09-01",
    content: { sku: { name: "Standard" }, properties: { publicIPAllocationMethod: "Static" } },
  },
  {
    id: "keyvault-no-purge-protection",
    label: "Key vault without purge protection",
    type: "Microsoft.KeyVault/vaults",
    apiVersion: "2023-07-01",
    content: { properties: { tenantId: "00000000-0000-0000-0000-000000000000", sku: { family: "A", name: "standard" }, enableSoftDelete: true, enablePurgeProtection: false } },
  },
  {
    id: "sql-public-network",
    label: "SQL server open to public networks",
    type: "Microsoft.Sql/servers",
    apiVersion: "2023-05-01-preview",
    content: { properties: { publicNetworkAccess: "Enabled", minimalTlsVersion: "1.2" } },
  },
  {
    id: "untagged-resource",
    label: "Resource without the required tags",
    type: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
    content: { kind: "StorageV2", sku: { name: "Standard_LRS" }, tags: {}, properties: { allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: "TLS1_2" } },
  },
  {
    id: "denied-region",
    label: "Resource in a region that should be blocked",
    type: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
    needsDeniedRegion: true,
    content: { kind: "StorageV2", sku: { name: "Standard_LRS" }, properties: { allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: "TLS1_2" } },
  },
];

function enabledProbes() {
  const raw = (settings.get("POLICY_PROBES") || "").trim();
  if (raw.toLowerCase() === "none") return [];
  const wanted = raw ? new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const deniedRegion = settings.get("POLICY_PROBE_DENIED_REGION");
  return PROBES.filter((p) => (!wanted || wanted.has(p.id)) && (!p.needsDeniedRegion || deniedRegion));
}

function probeBody(probe) {
  const region = probe.needsDeniedRegion
    ? settings.get("POLICY_PROBE_DENIED_REGION")
    : settings.get("POLICY_PROBE_REGION") || "norwayeast";
  return {
    resourceDetails: {
      resourceContent: { type: probe.type, name: `policyprobe${probe.id.replace(/[^a-z0-9]/g, "").slice(0, 12)}`, location: region, ...probe.content },
      apiVersion: probe.apiVersion,
    },
    pendingFields: [{ field: "name" }, { field: "tags" }],
  };
}

// "blocked" when any Deny says no; "audited" when only Audit-type effects
// notice it; "allowed" when nothing does.
function probeVerdict(result) {
  const evals = ((result && result.contentEvaluationResult) || {}).policyEvaluations || [];
  const nonCompliant = evals.filter((e) => String(e.evaluationResult).toLowerCase() === "noncompliant");
  const effectOf = (e) => String(((e.effectDetails || {}).policyEffect) || "").toLowerCase();
  const fieldDeny = ((result && result.fieldRestrictions) || []).some((f) =>
    (f.restrictions || []).some((r) => String(r.result).toLowerCase() === "deny")
  );
  if (fieldDeny || nonCompliant.some((e) => effectOf(e) === "deny")) return { verdict: "blocked" };
  const audited = nonCompliant.filter((e) => ["audit", "auditifnotexists"].includes(effectOf(e)));
  if (audited.length) {
    return { verdict: "audited", assignments: [...new Set(audited.map((e) => (e.policyInfo || {}).policyAssignmentId).filter(Boolean))] };
  }
  return { verdict: "allowed" };
}

async function runProbes(subscriptionIds, findings, tally) {
  const probes = enabledProbes();
  const jobs = subscriptionIds.flatMap((sub) => probes.map((probe) => ({ sub, probe })));
  await mapLimit(jobs, CONCURRENCY, async ({ sub, probe }) => {
    const url = `https://management.azure.com/subscriptions/${sub}/providers/Microsoft.PolicyInsights/checkPolicyRestrictions?api-version=2022-03-01`;
    let v;
    try {
      v = probeVerdict(await armPost(url, probeBody(probe), TOOL_ID));
    } catch (err) {
      tally.probeErrors++;
      if (tally.probeErrors <= 3) log.record({ tool: TOOL_ID, level: "error", message: `probe ${probe.id} in ${sub}: ${err.message.slice(0, 300)}` });
      return;
    }
    tally[v.verdict]++;
    if (v.verdict === "blocked") return;
    findings.push({
      kind: v.verdict === "audited" ? "probe-only-audited" : "probe-not-blocked",
      id: `probe/${sub}/${probe.id}`,
      name: probe.label,
      subscriptionId: sub,
      resourceGroup: null,
      probe: probe.id,
      detail:
        v.verdict === "audited"
          ? `would be created; policy only audits it (${v.assignments.length} assignment(s)), nothing denies it`
          : "would be created; no policy denies or audits it",
    });
  });
}

// --- Effects ---

const PARAM_RE = /^\[parameters\('([^']+)'\)\]$/i;

// "[parameters('x')]" -> the assignment's value, else the definition default.
function resolveValue(raw, assigned, declared) {
  if (typeof raw !== "string") return raw;
  const m = raw.match(PARAM_RE);
  if (!m) return raw.startsWith("[") ? null : raw; // other expressions: unknown
  const name = m[1];
  const a = (assigned || {})[name];
  if (a && a.value !== undefined) return a.value;
  const d = (declared || {})[name];
  return d && d.defaultValue !== undefined ? d.defaultValue : null;
}

function ruleThen(def) {
  return (((def || {}).properties || {}).policyRule || {}).then || {};
}

// Effect of one definition as assigned. memberParams: the initiative's
// parameter mapping for this member (values may point at initiative params).
function effectOf(def, assignment, set, memberParams) {
  const raw = ruleThen(def).effect;
  const declared = (def.properties || {}).parameters;
  if (!set) return lower(resolveValue(raw, (assignment.properties || {}).parameters, declared));
  const m = typeof raw === "string" && raw.match(PARAM_RE);
  if (!m) return lower(resolveValue(raw, {}, declared));
  const mapped = (memberParams || {})[m[1]];
  if (!mapped) return lower(resolveValue(raw, {}, declared));
  return lower(resolveValue(mapped.value, (assignment.properties || {}).parameters, (set.properties || {}).parameters));
}

function lower(v) {
  return typeof v === "string" ? v.toLowerCase() : null;
}

// --- Scope coverage (does a role at roleScope reach targetScope?) ---

function mgName(scope) {
  const m = (scope || "").match(/\/providers\/microsoft\.management\/managementgroups\/([^/]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function subOf(scope) {
  const m = (scope || "").match(/^\/subscriptions\/([^/]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function covers(roleScope, targetScope, ancestors) {
  const r = (roleScope || "").toLowerCase().replace(/\/+$/, "");
  const t = (targetScope || "").toLowerCase().replace(/\/+$/, "");
  if (r === "" || r === "/") return true;
  if (t === r || t.startsWith(`${r}/`)) return true;
  const roleMg = mgName(r);
  if (!roleMg || r.includes("/subscriptions/")) return false;
  const targetMg = mgName(t);
  const chain = targetMg ? [targetMg, ...(ancestors.get(`mg:${targetMg}`) || [])] : ancestors.get(`sub:${subOf(t)}`) || [];
  return chain.includes(roleMg);
}

function hasRole(heldGuids, needGuid) {
  if (heldGuids.has(needGuid) || heldGuids.has(OWNER)) return true;
  return heldGuids.has(CONTRIBUTOR) && needGuid !== UAA && needGuid !== OWNER;
}

const guidOf = (id) => String(id || "").split("/").pop().toLowerCase();

// --- Data ---

async function loadAncestors() {
  const rows = await resourceGraphQuery(
    `ResourceContainers
     | where type in~ ('microsoft.resources/subscriptions', 'microsoft.management/managementgroups')
     | project type, name, subscriptionId,
         chain = iff(type =~ 'microsoft.resources/subscriptions', properties.managementGroupAncestorsChain, properties.details.managementGroupAncestorsChain)`,
    { toolId: TOOL_ID, subscriptions: [] }
  );
  const map = new Map();
  for (const r of rows) {
    const chain = (r.chain || []).map((c) => String(c.name).toLowerCase());
    if (/subscriptions/i.test(r.type)) map.set(`sub:${String(r.subscriptionId).toLowerCase()}`, chain);
    else map.set(`mg:${String(r.name).toLowerCase()}`, chain);
  }
  return map;
}

function makeDefinitionCache() {
  const cache = new Map();
  let fetched = 0;
  return async function getDef(id) {
    const key = String(id).toLowerCase();
    if (cache.has(key)) return cache.get(key);
    if (fetched >= MAX_DEFINITIONS) return undefined; // over budget: unknown, not missing
    fetched++;
    const isSet = /policysetdefinitions/i.test(id);
    const p = armGet(`https://management.azure.com${id}?api-version=${isSet ? "2023-04-01" : "2023-04-01"}`, TOOL_ID).catch((err) =>
      /\(404\)/.test(err.message) ? null : Promise.reject(err)
    );
    cache.set(key, p);
    return p;
  };
}

// Assignment -> { effects: [{ definitionId, name, effect, roles }], missing: [...] }
async function analyseAssignment(a, getDef) {
  const defId = (a.properties || {}).policyDefinitionId;
  const top = await getDef(defId);
  if (top === null) return { missing: [defId], effects: [] };
  if (top === undefined) return { unknown: true, effects: [] };
  const describe = (def, set, memberParams) => ({
    definitionId: def.id,
    name: (def.properties || {}).displayName || def.name,
    effect: effectOf(def, a, set, memberParams),
    roles: ((ruleThen(def).details || {}).roleDefinitionIds || []).map(guidOf),
  });
  if (!/policysetdefinitions/i.test(defId)) return { effects: [describe(top)], missing: [] };

  const effects = [];
  const missing = [];
  const members = (top.properties || {}).policyDefinitions || [];
  await mapLimit(members, CONCURRENCY, async (m) => {
    const def = await getDef(m.policyDefinitionId);
    if (def === null) missing.push(m.policyDefinitionId);
    else if (def) effects.push(describe(def, top, m.parameters));
  });
  return { effects, missing };
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    })
  );
}

function identityPrincipals(identity) {
  if (!identity) return [];
  const ids = [];
  if (identity.principalId) ids.push(identity.principalId);
  for (const ua of Object.values(identity.userAssignedIdentities || {})) if (ua && ua.principalId) ids.push(ua.principalId);
  return ids.map((x) => String(x).toLowerCase());
}

function scopeText(scope) {
  const mg = mgName(scope);
  if (mg) return `management group ${mg}`;
  const rg = (scope || "").match(/\/resourceGroups\/([^/]+)/i);
  return rg ? `resource group ${rg[1]}` : "subscription";
}

async function healthChecks(findings, tally) {
  const now = Date.now();
  const [assignments, exemptions, states, ancestors] = await Promise.all([
    resourceGraphQuery(
      `PolicyResources
       | where type =~ 'microsoft.authorization/policyassignments'
       | project id, name, subscriptionId, resourceGroup, identity, properties`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(
      `PolicyResources
       | where type =~ 'microsoft.authorization/policyexemptions'
       | project id, name, subscriptionId, resourceGroup, properties`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(
      `PolicyResources
       | where type =~ 'microsoft.policyinsights/policystates'
       | summarize total = count(), nonCompliant = countif(tostring(properties.complianceState) =~ 'NonCompliant')
           by assignmentId = tolower(tostring(properties.policyAssignmentId))`,
      { toolId: TOOL_ID }
    ),
    loadAncestors(),
  ]);
  tally.assignments = assignments.length;
  const stateBy = new Map(states.map((s) => [s.assignmentId, s]));
  const getDef = makeDefinitionCache();

  // Every role held by every policy identity, in one query.
  const principals = [...new Set(assignments.flatMap((a) => identityPrincipals(a.identity)))];
  const rolesBy = new Map(); // principalId -> [{ scope, guid }]
  for (let i = 0; i < principals.length; i += 200) {
    const list = principals.slice(i, i + 200).map((p) => `'${p}'`).join(",");
    const rows = await resourceGraphQuery(
      `AuthorizationResources
       | where type =~ 'microsoft.authorization/roleassignments'
       | extend principalId = tolower(tostring(properties.principalId))
       | where principalId in (${list})
       | project principalId, scope = tostring(properties.scope), roleDefinitionId = tostring(properties.roleDefinitionId)`,
      { toolId: TOOL_ID, subscriptions: [] }
    );
    for (const r of rows) {
      if (!rolesBy.has(r.principalId)) rolesBy.set(r.principalId, []);
      rolesBy.get(r.principalId).push({ scope: r.scope, guid: guidOf(r.roleDefinitionId) });
    }
  }

  const remediatingAssignments = [];
  await mapLimit(assignments, CONCURRENCY, async (a) => {
    const p = a.properties || {};
    const name = p.displayName || a.name;
    const scope = p.scope || a.id.replace(/\/providers\/Microsoft\.Authorization\/policyAssignments\/.*$/i, "");
    const base = { id: a.id, name, subscriptionId: a.subscriptionId || null, resourceGroup: a.resourceGroup || null, scope, scopeText: scopeText(scope) };
    const where = base.subscriptionId ? "" : `[${base.scopeText}] `;
    const add = (kind, detail, extra) => findings.push({ ...base, kind, id: `${kind}/${a.id}`, detail: where + detail, ...extra });

    if (String(p.enforcementMode).toLowerCase() === "donotenforce") {
      add("enforcement-off", `enforcement is set to "Do not enforce" on ${base.scopeText}: deny and deploy effects do nothing`);
    }

    let analysis;
    try {
      analysis = await analyseAssignment(a, getDef);
    } catch (err) {
      tally.lookupErrors++;
      if (tally.lookupErrors <= 3) log.record({ tool: TOOL_ID, level: "error", message: `definition lookup for ${name}: ${err.message.slice(0, 300)}` });
      return;
    }
    if (analysis.missing.length) {
      add("definition-missing", `${analysis.missing.length} policy definition(s) it points to no longer exist`);
    }
    const effects = analysis.effects;
    const allDisabled = effects.length > 0 && effects.every((e) => e.effect === "disabled");
    if (allDisabled) {
      add("effect-disabled", "every policy in it resolves to the Disabled effect: it checks nothing");
    }

    const remediating = effects.filter((e) => ["deployifnotexists", "modify"].includes(e.effect));
    if (remediating.length) {
      const held = identityPrincipals(a.identity);
      if (!held.length) {
        add("identity-missing", `${remediating.length} deploy/modify polic${remediating.length === 1 ? "y" : "ies"} but no managed identity: nothing can be fixed`);
      } else {
        const roles = held.flatMap((pid) => rolesBy.get(pid) || []).filter((r) => covers(r.scope, scope, ancestors));
        const heldGuids = new Set(roles.map((r) => r.guid));
        const needed = [...new Set(remediating.flatMap((e) => e.roles))];
        const lacking = needed.filter((g) => !hasRole(heldGuids, g));
        if (lacking.length) {
          add("identity-lacks-roles", `its identity lacks ${lacking.map((g) => ROLE_NAMES[g] || g).join(", ")} on ${base.scopeText}: remediation will fail`, {
            missingRoles: lacking.map((g) => ROLE_NAMES[g] || g),
          });
        }
      }
      remediatingAssignments.push({ a, base, add });
    }

    const st = stateBy.get(a.id.toLowerCase());
    const createdOn = Date.parse(((p.metadata || {}).createdOn) || "") || 0;
    if (!st && !allDisabled && createdOn && now - createdOn > 2 * DAY) {
      add("evaluates-nothing", "no resource has been evaluated against it: scope, exclusions or resource types match nothing");
    }
    tally.nonCompliant += st ? st.nonCompliant : 0;
  });

  await remediationChecks(remediatingAssignments, stateBy, tally);

  for (const x of exemptions) {
    const p = x.properties || {};
    const name = p.displayName || x.name;
    const base = { name, subscriptionId: x.subscriptionId || null, resourceGroup: x.resourceGroup || null };
    const expires = Date.parse(p.expiresOn || "");
    if (!p.expiresOn) {
      findings.push({ ...base, kind: "exemption-no-expiry", id: `exemption-no-expiry/${x.id}`, detail: `${p.exemptionCategory || "exemption"} with no end date` });
    } else if (expires < now) {
      findings.push({ ...base, kind: "exemption-expired", id: `exemption-expired/${x.id}`, detail: `expired ${p.expiresOn}; delete it or renew it on purpose` });
    } else if (expires - now < 14 * DAY) {
      findings.push({ ...base, kind: "exemption-expiring", id: `exemption-expiring/${x.id}`, detail: `expires ${p.expiresOn}` });
    }
  }
}

// Deploy/modify policies only fix existing resources through a remediation
// task; flag ones with non-compliant resources and no recent successful task.
async function remediationChecks(items, stateBy, tally) {
  if (!items.length) return;
  const scopes = new Set();
  for (const { base } of items) {
    const mg = mgName(base.scope);
    scopes.add(mg ? `/providers/Microsoft.Management/managementGroups/${mg}` : `/subscriptions/${subOf(base.scope)}`);
  }
  const tasks = [];
  await mapLimit([...scopes], CONCURRENCY, async (scope) => {
    let url = `https://management.azure.com${scope}/providers/Microsoft.PolicyInsights/remediations?api-version=2021-10-01`;
    try {
      while (url) {
        const page = await armGet(url, TOOL_ID);
        tasks.push(...(page.value || []));
        url = page.nextLink;
      }
    } catch (err) {
      tally.lookupErrors++;
      if (tally.lookupErrors <= 3) log.record({ tool: TOOL_ID, level: "error", message: `remediation list at ${scope}: ${err.message.slice(0, 300)}` });
    }
  });
  const recent = Date.now() - 30 * DAY;
  for (const { a, add } of items) {
    const mine = tasks.filter((t) => String(((t.properties || {}).policyAssignmentId) || "").toLowerCase() === a.id.toLowerCase());
    const failed = mine.filter((t) => {
      const p = t.properties || {};
      const when = Date.parse(p.lastUpdatedOn || p.createdOn || "") || 0;
      return when > recent && (/failed/i.test(p.provisioningState) || ((p.deploymentStatus || {}).failedDeployments || 0) > 0);
    });
    if (failed.length) {
      const failedDeployments = failed.reduce((n, t) => n + (((t.properties || {}).deploymentStatus || {}).failedDeployments || 0), 0);
      add("remediation-failed", `${failed.length} remediation task(s) failed in the last 30 days (${failedDeployments} failed deployment(s))`);
    }
    const st = stateBy.get(a.id.toLowerCase());
    const ranRecently = mine.some((t) => (Date.parse((t.properties || {}).createdOn || "") || 0) > recent);
    if (st && st.nonCompliant > 0 && !ranRecently) {
      add("remediation-not-run", `${st.nonCompliant} non-compliant resource(s) and no remediation task in the last 30 days: existing resources stay unfixed`);
    }
  }
}

async function run() {
  const findings = [];
  const tally = { blocked: 0, audited: 0, allowed: 0, probeErrors: 0, lookupErrors: 0, assignments: 0, nonCompliant: 0 };
  const subs = await subscriptionIdsToScan(TOOL_ID);
  const results = await Promise.allSettled([runProbes(subs, findings, tally), healthChecks(findings, tally)]);
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;
  // Shown on the scan page, not only in the log.
  const names = ["Probes", "Assignment health"];
  results.forEach((r, i) => {
    if (r.status === "rejected") findings.push(scanError(TOOL_ID, names[i], `${names[i]} check failed`, String(r.reason.message).slice(0, 300)));
  });
  if (tally.probeErrors) findings.push(scanError(TOOL_ID, "probe-calls", `${tally.probeErrors} probe call(s) failed`, "Those probes were not checked; the log has the first errors"));
  if (tally.lookupErrors) findings.push(scanError(TOOL_ID, "lookups", `${tally.lookupErrors} definition or remediation lookup(s) failed`, "Those assignments were only partly checked; the log has the first errors"));
  log.record({
    tool: TOOL_ID,
    level: "info",
    message: `probes: ${tally.blocked} blocked, ${tally.audited} only audited, ${tally.allowed} allowed, ${tally.probeErrors} failed; ${tally.assignments} assignment(s) checked`,
  });
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Policy check",
  schedule: "30 5 * * *", // nightly at 05:30
  run,
  PROBES,
  _test: { probeVerdict, resolveValue, effectOf, covers, hasRole, analyseAssignment, healthChecks, runProbes },
};
