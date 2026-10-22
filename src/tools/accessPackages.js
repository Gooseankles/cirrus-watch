// Entra ID Governance "access packages" (entitlement management) — the
// self-service catalog people request time-bound access through. Needs
// Graph Application permission EntitlementManagement.Read.All (admin
// consent) in addition to the ones the other tools use, plus
// GroupMember.Read.All and User.Read.All to see who is behind the approvers.
const graph = require("../graphClient");
const settings = require("../settings");
const { runChecks, mapLimit, scanError, graphHint } = require("./util");

const graphGetAll = (path, toolId) => graph.graphGetAll(path, toolId);

const TOOL_ID = "access-packages";

function expiringWarnDays() {
  return Number(settings.get("ACCESS_PACKAGE_EXPIRY_WARN_DAYS")) || 14;
}
function stalePendingDays() {
  return Number(settings.get("ACCESS_PACKAGE_STALE_PENDING_DAYS")) || 7;
}
function unusedAgeDays() {
  return Number(settings.get("ACCESS_PACKAGE_UNUSED_AGE_DAYS")) || 30;
}

async function expiringAssignments() {
  // $expand pulls in the package + target names so findings are readable
  // without a second round-trip per assignment.
  const assignments = await graphGetAll(
    "/identityGovernance/entitlementManagement/assignments" +
      "?$filter=state eq 'Delivered'&$expand=accessPackage,target&$top=999",
    TOOL_ID
  );

  const cutoff = Date.now() + expiringWarnDays() * 24 * 60 * 60 * 1000;
  const findings = [];
  for (const a of assignments) {
    const expiresOn = a.schedule && a.schedule.expiration && a.schedule.expiration.endDateTime;
    if (!expiresOn) continue; // no expiry set = permanent assignment, nothing to flag
    if (new Date(expiresOn).getTime() > cutoff) continue;

    findings.push({
      kind: "access-package-expiring",
      id: a.id,
      name: `${(a.target && a.target.displayName) || a.targetId} -> ${(a.accessPackage && a.accessPackage.displayName) || a.accessPackageId}`,
      resourceGroup: null,
      subscriptionId: null,
      detail: `expires ${expiresOn}`,
    });
  }
  return findings;
}

async function stalePendingRequests() {
  const requests = await graphGetAll(
    "/identityGovernance/entitlementManagement/accessPackageAssignmentRequests" +
      "?$filter=state eq 'PendingApproval'&$expand=accessPackage,requestor&$top=999",
    TOOL_ID
  );

  const cutoff = Date.now() - stalePendingDays() * 24 * 60 * 60 * 1000;
  const findings = [];
  for (const r of requests) {
    const createdOn = r.createdDateTime ? new Date(r.createdDateTime).getTime() : null;
    if (!createdOn || createdOn > cutoff) continue;

    findings.push({
      kind: "access-package-pending-too-long",
      id: r.id,
      name: `${(r.requestor && r.requestor.displayName) || r.requestorId} -> ${(r.accessPackage && r.accessPackage.displayName) || r.accessPackageId}`,
      resourceGroup: null,
      subscriptionId: null,
      detail: `pending approval since ${r.createdDateTime}`,
    });
  }
  return findings;
}

function normalizePackageName(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Packages nobody actually has (past the point of being "newly published"),
// and packages whose names collide once case/punctuation is ignored —
// usually two packages granting near-identical access that should be merged.
async function unusedAndDuplicatePackages() {
  const [packages, assignments] = await Promise.all([
    graphGetAll(
      "/identityGovernance/entitlementManagement/accessPackages?$select=id,displayName,createdDateTime&$top=999",
      TOOL_ID
    ),
    graphGetAll(
      "/identityGovernance/entitlementManagement/assignments" +
        "?$filter=state eq 'Delivered'&$select=accessPackageId&$top=999",
      TOOL_ID
    ),
  ]);

  const assignmentCountByPackage = {};
  for (const a of assignments) {
    assignmentCountByPackage[a.accessPackageId] = (assignmentCountByPackage[a.accessPackageId] || 0) + 1;
  }

  const findings = [];

  const unusedCutoff = Date.now() - unusedAgeDays() * 24 * 60 * 60 * 1000;
  for (const p of packages) {
    if (assignmentCountByPackage[p.id]) continue; // has at least one current assignment
    const createdOn = p.createdDateTime ? new Date(p.createdDateTime).getTime() : null;
    if (!createdOn || createdOn > unusedCutoff) continue; // too new to call "unused" yet

    findings.push({
      kind: "access-package-unused",
      id: p.id,
      name: p.displayName,
      resourceGroup: null,
      subscriptionId: null,
      detail: `no active assignments, created ${p.createdDateTime}`,
    });
  }

  const byNormalizedName = {};
  for (const p of packages) {
    const key = normalizePackageName(p.displayName);
    if (!key) continue;
    (byNormalizedName[key] = byNormalizedName[key] || []).push(p);
  }
  for (const group of Object.values(byNormalizedName)) {
    if (group.length < 2) continue;
    findings.push({
      kind: "access-package-duplicate-name",
      id: group.map((p) => p.id).join(","),
      name: group[0].displayName,
      resourceGroup: null,
      subscriptionId: null,
      detail: `${group.length} packages share this name — consider merging: ${group.map((p) => p.id).join(", ")}`,
    });
  }

  return findings;
}

const GROUP_APPROVER = "#microsoft.graph.groupMembers";
const USER_APPROVER = "#microsoft.graph.singleUser";
const LOOKUP_CONCURRENCY = 8;

const isNotFound = (err) => /failed \(404\)/.test(String((err && err.message) || err));

// The people behind each approver group and named approver, looked up once
// per run: { groups: Map(id -> { name, deleted, people: [{ id, name }] }),
// users: Map(id -> { name, deleted, enabled }), failures }. Only enabled
// accounts count: a disabled one cannot sign in to approve.
async function resolveApprovers(groupIds, userIds) {
  const groups = new Map();
  const users = new Map();
  const groupFailures = await mapLimit([...groupIds], LOOKUP_CONCURRENCY, async (id) => {
    try {
      const [group, members] = await Promise.all([
        graph.graphGet(`/groups/${id}?$select=id,displayName`, TOOL_ID),
        graph.graphGetAll(`/groups/${id}/transitiveMembers/microsoft.graph.user?$select=id,displayName,accountEnabled&$top=999`, TOOL_ID),
      ]);
      const people = members.filter((m) => m.accountEnabled !== false).map((m) => ({ id: m.id, name: m.displayName || m.id }));
      groups.set(id, { name: group.displayName || id, deleted: false, people, disabled: members.length - people.length });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      groups.set(id, { name: id, deleted: true, people: [], disabled: 0 });
    }
  });
  const userFailures = await mapLimit([...userIds], LOOKUP_CONCURRENCY, async (id) => {
    try {
      const u = await graph.graphGet(`/users/${id}?$select=id,displayName,accountEnabled`, TOOL_ID);
      users.set(id, { name: u.displayName || id, deleted: false, enabled: u.accountEnabled !== false });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      users.set(id, { name: id, deleted: true, enabled: false });
    }
  });
  return { groups, users, failures: [...groupFailures, ...userFailures] };
}

// Who can act on one list of approvers (a stage's primary or fallback list).
// Approvers worked out per request (the requestor's manager, sponsors) are
// "dynamic": they can't be counted here, so the list is treated as working.
function approverList(subjects, resolved) {
  const people = new Map();
  const broken = []; // plain-words problems: "group X has no members"
  let dynamic = false;
  let unknown = false;
  for (const s of subjects || []) {
    const type = s["@odata.type"];
    if (type === GROUP_APPROVER) {
      const g = resolved.groups.get(s.groupId);
      if (!g) { unknown = true; continue; }
      if (g.deleted) broken.push(`group ${s.description || s.groupId} was deleted`);
      else if (!g.people.length) broken.push(`group ${g.name} has no ${g.disabled ? "enabled " : ""}members`);
      for (const p of g.people) people.set(p.id, p.name);
    } else if (type === USER_APPROVER) {
      const u = resolved.users.get(s.userId);
      if (!u) { unknown = true; continue; }
      if (u.deleted) broken.push(`approver ${s.description || s.userId} was deleted`);
      else if (!u.enabled) broken.push(`approver ${u.name} is disabled`);
      else people.set(s.userId, u.name);
    } else {
      dynamic = true;
    }
  }
  return { people, broken, dynamic, unknown };
}

// The riskiest combination a policy can have: nobody has to approve the
// request, AND the access it grants never expires on its own. A policy that
// requires approval is checked against the people behind its approvers:
// a stage nobody can approve (empty or deleted groups, deleted or disabled
// users) blocks every request; an empty group next to working approvers is
// still worth cleaning up; and exactly one person across the whole policy is
// a bus-factor risk.
function policyFindings(packages, resolved) {
  const findings = [];
  for (const p of packages) {
    for (const policy of p.assignmentPolicies || []) {
      const approval = policy.requestApprovalSettings || {};
      const expirationType = policy.expiration && policy.expiration.type;
      const policyLabel = `${p.displayName} / ${policy.displayName || policy.id}`;
      const base = { id: policy.id, name: policyLabel, resourceGroup: null, subscriptionId: null };

      if (!approval.isApprovalRequired) {
        if (!expirationType || expirationType === "noExpiration") {
          findings.push({ ...base, kind: "access-package-auto-approved-no-expiry", detail: "no approval required and access never expires" });
        }
        continue;
      }

      const stages = approval.approvalStages || [];
      const everyone = new Map();
      const blocked = stages.length ? [] : ["no approvers set"];
      const emptyGroups = [];
      let dynamic = false;
      let unknown = false;
      stages.forEach((stage, i) => {
        const primary = approverList(stage.primaryApprovers, resolved);
        const fallback = approverList(stage.fallbackPrimaryApprovers, resolved);
        for (const [id, name] of [...primary.people, ...fallback.people]) everyone.set(id, name);
        dynamic = dynamic || primary.dynamic || fallback.dynamic;
        unknown = unknown || primary.unknown || fallback.unknown;
        const problems = [...primary.broken, ...fallback.broken];
        const nobody = !primary.people.size && !fallback.people.size && !primary.dynamic && !fallback.dynamic && !primary.unknown && !fallback.unknown;
        const where = stages.length > 1 ? `stage ${i + 1}: ` : "";
        if (nobody) blocked.push(where + (problems.length ? problems.join(", ") : "no approvers set"));
        else if (problems.length) emptyGroups.push(where + problems.join(", "));
      });

      if (blocked.length) {
        findings.push({
          ...base,
          id: `${policy.id}#approvers`,
          kind: "access-package-no-approver",
          detail: `Nobody can approve requests: ${blocked.join("; ")}. Requests wait until they expire`,
        });
      } else if (emptyGroups.length) {
        findings.push({
          ...base,
          id: `${policy.id}#approvers`,
          kind: "access-package-empty-approver-group",
          detail: `${emptyGroups.join("; ")}. Other approvers can still approve; remove or fill it`,
        });
      }
      if (!blocked.length && !dynamic && !unknown && everyone.size === 1) {
        const [only] = everyone.values();
        findings.push({
          ...base,
          kind: "access-package-single-approver",
          detail: `only one person can approve requests for this policy (${only}); if they are away, nothing gets approved`,
        });
      }
    }
  }
  return findings;
}

async function policyRiskFindings() {
  const packages = await graph.graphGetAll(
    "/identityGovernance/entitlementManagement/accessPackages?$expand=assignmentPolicies&$top=999",
    TOOL_ID
  );
  const groupIds = new Set();
  const userIds = new Set();
  for (const p of packages) {
    for (const policy of p.assignmentPolicies || []) {
      const approval = policy.requestApprovalSettings || {};
      if (!approval.isApprovalRequired) continue;
      for (const stage of approval.approvalStages || []) {
        for (const s of [...(stage.primaryApprovers || []), ...(stage.fallbackPrimaryApprovers || [])]) {
          if (s["@odata.type"] === GROUP_APPROVER && s.groupId) groupIds.add(s.groupId);
          if (s["@odata.type"] === USER_APPROVER && s.userId) userIds.add(s.userId);
        }
      }
    }
  }
  const resolved = await resolveApprovers(groupIds, userIds);
  const findings = policyFindings(packages, resolved);
  if (resolved.failures.length) {
    const first = resolved.failures[0];
    findings.push(
      scanError(
        TOOL_ID,
        "approvers",
        `${resolved.failures.length} of ${groupIds.size + userIds.size} approvers not checked`,
        graphHint(first.message, "GroupMember.Read.All and User.Read.All")
      )
    );
  }
  return findings;
}

// A failed check shows as a scan-error finding; run() throws only when every
// check fails.
function run() {
  return runChecks(TOOL_ID, {
    "Expiring assignments": expiringAssignments,
    "Pending requests": stalePendingRequests,
    "Unused and duplicate packages": unusedAndDuplicatePackages,
    "Policy risks": policyRiskFindings,
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Access packages",
  schedule: "0 5 * * *", // nightly at 05:00
  run,
  _test: { policyFindings, approverList },
};
