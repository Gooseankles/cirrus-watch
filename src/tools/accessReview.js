const { resourceGraphQuery } = require("../armClient");
const { graphPost, graphGet } = require("../graphClient");
const settings = require("../settings");
const log = require("../log");

const TOOL_ID = "access-review";

// Well-known built-in role definition GUIDs (the last segment of
// roleDefinitionId) — covers the common ones worth flagging without an
// extra ARM call per assignment to resolve the role's display name.
const KNOWN_ROLES = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "acdd72a7-3385-48ef-bd42-f606fba81ae7": "Reader",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
};
const PRIVILEGED = ["Owner", "Contributor", "User Access Administrator"];

// A group with thousands of members would bloat the findings file; the
// total is still reported.
const MAX_MEMBERS_KEPT = 500;
const MAX_GROUPS_WALKED = 200; // per assigned group, nested ones included
const GROUP_CONCURRENCY = 4;

function staleDays() {
  return Number(settings.get("AZURE_ACCESS_REVIEW_STALE_DAYS")) || 365;
}

// Object ID -> { name, upn } for users and groups. Needs Graph
// User.Read.All + GroupMember.Read.All (or Directory.Read.All).
async function resolveNames(ids) {
  const names = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 1000) {
    const page = await graphPost(
      "/directoryObjects/getByIds?$select=id,displayName,userPrincipalName",
      { ids: unique.slice(i, i + 1000), types: ["user", "group"] },
      TOOL_ID
    );
    for (const o of page.value || []) {
      names.set(o.id, { name: o.displayName || o.id, upn: o.userPrincipalName || null });
    }
  }
  return names;
}

function memberType(odataType) {
  const t = (odataType || "").replace("#microsoft.graph.", "");
  return { user: "User", group: "Group", servicePrincipal: "App", device: "Device" }[t] || t || "Other";
}

// A group's direct members; one fetch per group per run, since nested groups
// are often shared between several assigned groups.
async function directMembers(groupId, cache) {
  if (!cache.has(groupId)) {
    cache.set(
      groupId,
      (async () => {
        const out = [];
        let next = `/groups/${groupId}/members?$select=id,displayName,userPrincipalName,accountEnabled&$top=999`;
        while (next) {
          const page = await graphGet(next, TOOL_ID);
          for (const m of page.value || []) {
            out.push({ id: m.id, name: m.displayName || m.id, upn: m.userPrincipalName || null, type: memberType(m["@odata.type"]), enabled: m.accountEnabled !== false });
          }
          next = page["@odata.nextLink"] || null;
        }
        return out.sort((a, b) => (a.type === "Group") - (b.type === "Group") || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
      })()
    );
  }
  return cache.get(groupId);
}

// Everyone in the group as a tree: each member carries `via`, the group it is
// a direct member of, so nested groups can be opened on the page. A group seen
// twice on one path (a loop) is not followed again.
async function groupMembers(groupId, cache) {
  const members = [];
  const people = new Set();
  let nestedGroups = 0;
  let groupsRead = 0;
  let truncated = false;
  const walk = async (id, path) => {
    if (groupsRead >= MAX_GROUPS_WALKED) {
      truncated = true;
      return;
    }
    groupsRead += 1;
    for (const m of await directMembers(id, cache)) {
      if (members.length < MAX_MEMBERS_KEPT) members.push({ ...m, via: id });
      else truncated = true;
      if (m.type !== "Group") people.add(m.id);
      else if (!path.includes(m.id)) {
        nestedGroups += 1;
        await walk(m.id, [...path, m.id]);
      }
    }
  };
  await walk(groupId, [groupId]);
  return { members, memberTotal: people.size, nestedGroups, truncated };
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    })
  );
}

function scopeLabel(scope) {
  const s = scope || "";
  const rg = s.match(/\/resourceGroups\/([^/]+)/i);
  if (/\/providers\/Microsoft\.Management\/managementGroups\//i.test(s)) {
    return { level: "Management group", rg: null, target: s.split("/").pop() };
  }
  if (!rg) return { level: /^\/subscriptions\/[^/]+\/?$/i.test(s) ? "Subscription" : "Root", rg: null, target: null };
  const isResource = s.split("/").length > 5;
  return { level: isResource ? "Resource" : "Resource group", rg: rg[1], target: isResource ? s.split("/").pop() : rg[1] };
}

async function run() {
  const rows = await resourceGraphQuery(
    `
    AuthorizationResources
    | where type == 'microsoft.authorization/roleassignments'
    | where tostring(properties.principalType) in ('User', 'Group')
    | project id, principalId = tostring(properties.principalId), principalType = tostring(properties.principalType),
        roleDefinitionId = tostring(properties.roleDefinitionId), scope = tostring(properties.scope),
        createdOn = properties.createdOn, subscriptionId
  `,
    { toolId: TOOL_ID }
  );

  const now = Date.now();
  const cutoff = now - staleDays() * 24 * 60 * 60 * 1000;
  const findings = [];

  for (const r of rows) {
    const roleGuid = (r.roleDefinitionId || "").split("/").pop();
    const roleName = KNOWN_ROLES[roleGuid] || roleGuid;
    if (!PRIVILEGED.includes(roleName)) continue;

    const createdOn = r.createdOn ? new Date(r.createdOn) : null;
    if (!createdOn || createdOn.getTime() >= cutoff) continue;

    const isGroup = r.principalType === "Group";
    const where = scopeLabel(r.scope);
    findings.push({
      kind: isGroup ? "stale-group-assignment" : "stale-direct-assignment",
      id: r.id,
      principalId: r.principalId,
      principalType: r.principalType,
      name: r.principalId,
      upn: null,
      role: roleName,
      scope: r.scope,
      scopeLevel: where.level,
      scopeTarget: where.target,
      resourceGroup: where.rg,
      subscriptionId: r.subscriptionId || null,
      createdOn: createdOn.toISOString(),
      ageDays: Math.floor((now - createdOn.getTime()) / 86400000),
      detail: `${roleName} ${isGroup ? "on a group" : "directly on a user"} since ${createdOn.toISOString().slice(0, 10)} (scope: ${r.scope})`,
    });
  }

  if (!findings.length) return findings;

  try {
    const names = await resolveNames(findings.map((f) => f.principalId));
    for (const f of findings) {
      const n = names.get(f.principalId);
      if (n) {
        f.name = n.name;
        f.upn = n.upn;
      } else {
        f.missing = true;
      }
    }
  } catch (err) {
    log.record({
      tool: TOOL_ID,
      level: "error",
      message: `showing object IDs, could not look up names (needs Graph User.Read.All and GroupMember.Read.All): ${err.message}`,
    });
  }

  const groupIds = [...new Set(findings.filter((f) => f.principalType === "Group").map((f) => f.principalId))];
  const membersByGroup = new Map();
  let memberErrors = 0;
  let firstMemberError = null;
  const memberCache = new Map();
  await mapLimit(groupIds, GROUP_CONCURRENCY, async (id) => {
    try {
      membersByGroup.set(id, await groupMembers(id, memberCache));
    } catch (err) {
      memberErrors += 1;
      firstMemberError = firstMemberError || err.message;
    }
  });
  if (memberErrors) {
    log.record({
      tool: TOOL_ID,
      level: "error",
      message: `could not list members of ${memberErrors} group(s) (needs Graph GroupMember.Read.All): ${firstMemberError}`,
    });
  }
  for (const f of findings) {
    const m = membersByGroup.get(f.principalId);
    if (m) {
      f.members = m.members;
      f.memberTotal = m.memberTotal;
      f.nestedGroups = m.nestedGroups;
      if (m.truncated) f.membersTruncated = true;
    }
  }

  findings.sort((a, b) => b.ageDays - a.ageDays);
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Access review",
  schedule: "0 5 * * 1", // weekly, Monday 05:00
  run,
};
