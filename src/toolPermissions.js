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
  // Key Vault Reader only with the item check on (Settings, Key Vault).
  get "key-vault"() {
    const on = /^(on|yes|true|1)$/i.test(String(require("./settings").get("KEYVAULT_ITEM_CHECK") || "").trim());
    return { azure: on ? ["Reader", "Key Vault Reader (vaults on access policies: list on secrets, keys and certificates)"] : READER };
  },
  "access-packages": { graph: ["EntitlementManagement.Read.All", "GroupMember.Read.All", "User.Read.All"], licence: "Entra ID P2 or ID Governance" },
  "role-assignments": { azure: READER, graph: ["User.Read.All", "GroupMember.Read.All", "Application.Read.All"] },
  "policy-check": { azure: READER },
  "internet-exposure": { azure: READER },
  "end-of-support": { azure: READER },
  "service-retirements": { azure: READER },
  certificates: { azure: READER },
  "backup-coverage": { azure: READER },
  resilience: { azure: READER },
  "resource-settings": { azure: READER },
  "exposure-paths": { azure: READER },
  "diagnostic-settings": { azure: READER },
  quotas: { azure: READER },
  ipam: { azure: READER },
  architecture: { azure: READER, graph: ["Application.Read.All"] },
  "firewall-policies": { azure: READER },
  "change-log": { azure: READER },
  "privileged-roles": {
    graph: ["RoleManagement.Read.Directory", "User.Read.All", "GroupMember.Read.All", "Application.Read.All", "AuditLog.Read.All", "Policy.Read.All"],
    licence: "Entra ID P1 for the MFA and emergency access checks, P2 for PIM",
  },
  pim: {
    azure: READER,
    graph: ["RoleManagement.Read.Directory", "User.Read.All", "GroupMember.Read.All", "PrivilegedEligibilitySchedule.Read.AzureADGroup", "PrivilegedAssignmentSchedule.Read.AzureADGroup"],
    licence: "Entra ID P2",
  },
  "stale-accounts": { graph: ["User.Read.All", "AuditLog.Read.All"], licence: "Entra ID P1 (sign-in activity)" },
  "mfa-coverage": { graph: ["User.Read.All", "AuditLog.Read.All"], licence: "Entra ID P1 (authentication methods report)" },
  "conditional-access": { graph: ["Policy.Read.All"], licence: "Entra ID P1" },
  "app-permissions": { graph: ["Application.Read.All", "DelegatedPermissionGrant.Read.All", "Policy.Read.All"] },
  // AuditLog.Read.All and Reader are optional: without them the unused-app and disabled-app checks are skipped.
  "enterprise-apps": { graph: ["Application.Read.All", "AuditLog.Read.All"], azure: ["Reader (optional: Azure roles held by disabled apps)"] },
  "licence-coverage": {
    azure: READER,
    graph: [
      "LicenseAssignment.Read.All", "User.Read.All", "GroupMember.Read.All", "Policy.Read.All", "RoleManagement.Read.Directory",
      "EntitlementManagement.Read.All", "PrivilegedEligibilitySchedule.Read.AzureADGroup", "PrivilegedAssignmentSchedule.Read.AzureADGroup",
    ],
  },
  defender: { azure: READER },
  vulnerabilities: { azure: READER },
  "safety-nets": { azure: READER },
  "azure-monitor": { azure: ["Reader", "Log Analytics Reader on the workspaces, if Reader alone cannot query them (heartbeat check)"] },
  updates: { azure: READER },
  "tenant-settings": { graph: ["Policy.Read.All"] },
  "resource-health": { azure: READER },
  subscriptions: { azure: ["Reader", "Reader at the Tenant Root Group, to see Owners given on management groups"] },
  "network-hygiene": { azure: READER },
  connectivity: { azure: READER },
  avd: { azure: READER },
  domains: { azure: READER, graph: ["User.Read.All"] },
  "access-lookup": {
    azure: READER,
    graph: ["User.Read.All", "GroupMember.Read.All", "RoleManagement.Read.Directory", "PrivilegedEligibilitySchedule.Read.AzureADGroup"],
    licence: "Entra ID P2 to see who can activate roles with PIM (eligible Azure roles come from the PIM scan)",
  },
};

function needsOf(toolId) {
  return NEEDS[toolId] || null;
}

module.exports = { needsOf, NEEDS };
