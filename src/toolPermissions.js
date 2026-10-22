// What each tool's scan identity needs, shown next to a failed scan ("does the
// app have these?"). In a customer tenant that identity is the customer's app
// registration. Keep in step with docs/permissions.md.
const READER = ["Reader"];

const NEEDS = {
  "orphaned-resources": { azure: READER },
  "tag-compliance": { azure: READER },
  "cost-anomaly": { azure: ["Cost Management Reader"] },
  "access-review": { azure: READER, graph: ["User.Read.All", "GroupMember.Read.All"] },
  "secret-expiry": { graph: ["Application.Read.All"] },
  "key-vault": { azure: ["Reader", "Key Vault Reader (vaults on access policies: list on secrets, keys and certificates)"] },
  "access-packages": { graph: ["EntitlementManagement.Read.All"], licence: "Entra ID P2 or ID Governance" },
  "role-assignments": { azure: READER, graph: ["User.Read.All", "GroupMember.Read.All", "Application.Read.All"] },
  "policy-check": { azure: READER },
  "internet-exposure": { azure: READER },
  "end-of-support": { azure: READER },
  "service-retirements": { azure: READER },
  "backup-coverage": { azure: READER },
  "diagnostic-settings": { azure: READER },
  quotas: { azure: READER },
  ipam: { azure: READER },
  "change-log": { azure: READER },
  "privileged-roles": {
    graph: ["RoleManagement.Read.Directory", "User.Read.All", "GroupMember.Read.All", "Application.Read.All", "AuditLog.Read.All"],
    licence: "Entra ID P1 for the MFA check, P2 for PIM",
  },
  "stale-accounts": { graph: ["User.Read.All", "AuditLog.Read.All"], licence: "Entra ID P1 (sign-in activity)" },
  "mfa-coverage": { graph: ["User.Read.All", "AuditLog.Read.All"], licence: "Entra ID P1 (authentication methods report)" },
  "conditional-access": { graph: ["Policy.Read.All"], licence: "Entra ID P1" },
  "app-permissions": { graph: ["Application.Read.All", "DelegatedPermissionGrant.Read.All", "Policy.Read.All"] },
  "licence-coverage": {
    azure: READER,
    graph: [
      "LicenseAssignment.Read.All", "User.Read.All", "GroupMember.Read.All", "Policy.Read.All", "RoleManagement.Read.Directory",
      "EntitlementManagement.Read.All", "PrivilegedEligibilitySchedule.Read.AzureADGroup", "PrivilegedAssignmentSchedule.Read.AzureADGroup",
    ],
  },
  "access-lookup": { azure: READER, graph: ["User.Read.All", "GroupMember.Read.All"] },
};

function needsOf(toolId) {
  return NEEDS[toolId] || null;
}

module.exports = { needsOf, NEEDS };
