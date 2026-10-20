// Entra ID Governance "access packages" (entitlement management) — the
// self-service catalog people request time-bound access through. Needs
// Graph Application permission EntitlementManagement.Read.All (admin
// consent) in addition to the ones the other tools use.
const { graphGetAll } = require("../graphClient");
const settings = require("../settings");

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

// The riskiest combination a policy can have: nobody has to approve the
// request, AND the access it grants never expires on its own. Separately,
// a policy that does require approval but has exactly one eligible
// approver across all stages is a bus-factor risk — if that person leaves
// or is unavailable, nothing can ever get approved.
async function policyRiskFindings() {
  const packages = await graphGetAll(
    "/identityGovernance/entitlementManagement/accessPackages?$expand=assignmentPolicies&$top=999",
    TOOL_ID
  );

  const findings = [];
  for (const p of packages) {
    for (const policy of p.assignmentPolicies || []) {
      const approvalRequired = policy.requestApprovalSettings && policy.requestApprovalSettings.isApprovalRequired;
      const expirationType = policy.expiration && policy.expiration.type;
      const policyLabel = `${p.displayName} / ${policy.displayName || policy.id}`;

      if (!approvalRequired) {
        if (!expirationType || expirationType === "noExpiration") {
          findings.push({
            kind: "access-package-auto-approved-no-expiry",
            id: policy.id,
            name: policyLabel,
            resourceGroup: null,
            subscriptionId: null,
            detail: "no approval required and access never expires",
          });
        }
        continue;
      }

      const stages = (policy.requestApprovalSettings && policy.requestApprovalSettings.approvalStages) || [];
      const approverCount = stages.reduce((sum, stage) => sum + ((stage.primaryApprovers || []).length), 0);
      if (approverCount === 1) {
        findings.push({
          kind: "access-package-single-approver",
          id: policy.id,
          name: policyLabel,
          resourceGroup: null,
          subscriptionId: null,
          detail: "only one person can approve requests for this policy",
        });
      }
    }
  }
  return findings;
}

async function run() {
  const results = await Promise.allSettled([
    expiringAssignments(),
    stalePendingRequests(),
    unusedAndDuplicatePackages(),
    policyRiskFindings(),
  ]);
  const findings = [];
  for (const r of results) {
    if (r.status === "fulfilled") findings.push(...r.value);
  }
  if (results.every((r) => r.status === "rejected")) {
    throw results[0].reason;
  }
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Access packages",
  schedule: "0 5 * * *", // nightly at 05:00
  run,
};
