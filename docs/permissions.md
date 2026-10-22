# Permissions

Every identity the dashboard uses and the access it needs, in one place. The scans only read; nothing here lets
the dashboard change a customer's resources.

| Identity | Where | Made by |
| --- | --- | --- |
| [Shared SPN](#shared-spn-home-tenant) | Home tenant | Terraform (the web app's system-assigned identity) |
| [Customer tenant app](#customer-tenant-app-other-tenants) | Each customer tenant | The customer, by hand |
| [Per-tool SPN](#per-tool-spn-optional) | Home tenant | You, optional |
| [Web app's own data](#web-apps-own-data) | Home tenant | Terraform |
| [SSO app](#sso-app) | Home tenant | Terraform, or by request |
| [Whoever runs Terraform](#whoever-runs-terraform) | Home tenant | — |

## Shared SPN (home tenant)

The web app's system-assigned managed identity. Every tool without its own SPN scans the home tenant with it.
Terraform grants all of this through `shared_spn_access` and `grant_graph_permissions`.

**Azure roles**, on each subscription to scan, or once on a management group so new subscriptions are picked up
automatically:

| Role | Used for |
| --- | --- |
| Reader | Every scan: resources, Resource Graph (including Advisor, backup items and resource changes), metrics, diagnostic settings, role assignments, NSG rules, storage container and database firewall lists, App Service config, AKS versions, quota usage, Defender for Cloud secure scores, recommendations and plans, budgets and resource locks, virtual network subnet usage, Azure Policy (including the `checkPolicyRestrictions` probes, a read operation) |
| Cost Management Reader | Cost anomalies and cost history |
| Key Vault Reader | Names and expiry dates of secrets, keys and certificates on RBAC vaults; never a secret's value |

A vault still on access policies needs a policy for the identity with **list** on secrets, keys and certificates
instead of Key Vault Reader. A vault whose firewall keeps the dashboard out shows as "Items not checked".

**Microsoft Graph application permissions**, with admin consent:

| Permission | Used for |
| --- | --- |
| `User.Read.All` | Access lookup (search people by name and find them), names of role holders |
| `GroupMember.Read.All` | Group memberships and group search (access lookup, with the chain through nested groups; access review; privileged roles: members of groups that hold an admin role; access packages: who is in each approver group) |
| `Application.Read.All` | App registration secret and certificate expiry |
| `EntitlementManagement.Read.All` | Access packages (only matters with Entra ID Governance / P2) |
| `RoleManagement.Read.Directory` | Privileged roles: who holds Entra admin roles, PIM eligibility (PIM needs P2); access lookup: a person's or group's Entra roles |
| `AuditLog.Read.All` | Stale accounts (last sign-in), MFA coverage and admins' MFA registration; all need Entra ID P1 or P2 |
| `Policy.Read.All` | Conditional Access policies, security defaults and the user consent setting (Conditional Access needs P1) |
| `DelegatedPermissionGrant.Read.All` | App permissions: delegated consents given to apps |
| `LicenseAssignment.Read.All` | Licence coverage: the licences the tenant owns |
| `PrivilegedEligibilitySchedule.Read.AzureADGroup`, `PrivilegedAssignmentSchedule.Read.AzureADGroup` | Licence coverage: who is eligible or time-bound in PIM for Groups |

All of these only read. Without P1 the stale accounts and MFA coverage scans and the admin MFA check report that the licence is
missing; the other checks still run.

No Entra directory role is needed.

**Licence coverage** counts licences the way Microsoft does: one per member user who benefits, not one per feature
switched on. P1 for everyone in scope of an enabled Conditional Access policy; P2 (or ID Governance) for people in
scope of a risk-based policy, with an eligible or time-bound PIM assignment (Entra roles, Azure roles, PIM for Groups)
or with an access package; ID Governance for access packages that use auto-assignment or custom extensions. Guests
are billed per monthly active user instead and are shown apart. Not counted: PIM approvers and access reviews.

## Customer tenant app (other tenants)

Each customer tenant has its own app registration, made in that tenant by the customer (Terraform never touches a
customer tenant). It needs **the same access as the shared SPN, granted in the customer's tenant**:

1. **App registration**: single tenant. Its Application (client) ID goes in Terraform's `customers.<key>.client_id`
   or in Settings → Customer tenants.
2. **Client secret**: Certificates & secrets → New client secret. Paste the value in Settings → Customer tenants →
   Edit; it is kept in the dashboard's key vault and never shown again. Note the expiry date: the dashboard stops
   scanning that tenant when it runs out. (A managed identity or federated credential cannot be used across tenants;
   Entra refuses it with AADSTS700236.)
3. **Entra (Microsoft Graph)**: API permissions → Microsoft Graph → **Application** permissions `User.Read.All`,
   `GroupMember.Read.All`, `Application.Read.All`, `EntitlementManagement.Read.All`, `RoleManagement.Read.Directory`,
   `AuditLog.Read.All`, `Policy.Read.All`, `DelegatedPermissionGrant.Read.All`, `LicenseAssignment.Read.All`,
   `PrivilegedEligibilitySchedule.Read.AzureADGroup`, `PrivilegedAssignmentSchedule.Read.AzureADGroup`, then **Grant admin consent**
   (needs a Privileged Role Administrator or Global Administrator in that tenant). No directory role.
4. **Subscriptions (Azure RBAC)**: `Reader`, `Cost Management Reader` and `Key Vault Reader` for the app's
   service principal on each subscription to scan, or on a management group (the tenant root group's ID is the
   tenant ID) to cover all of them:

   ```
   az role assignment create --assignee <client-id> --role "Reader"                 --scope /subscriptions/<id>
   az role assignment create --assignee <client-id> --role "Cost Management Reader" --scope /subscriptions/<id>
   az role assignment create --assignee <client-id> --role "Key Vault Reader"       --scope /subscriptions/<id>
   ```

   Giving these needs Owner, User Access Administrator or Role Based Access Control Administrator there.

`terraform output customer_onboarding` prints these steps per customer, with that customer's subscription IDs
filled in. Settings → Customer tenants → Test checks that the app can sign in to Azure and to Graph; a missing role or Graph
permission shows up later as an error entry on that tool's page, never as an empty result. Test also lists what is
missing: Graph application permissions from the `roles` claim of the app's Graph token (only consented ones are in
it), and the roles above on each subscription the app can see (assignments on a management group above count; a role
given through a group is not seen). The shared SPN's and each SPN override's Test connection do the same for the
tools they serve, and a failed scan shows the permissions its tool needs.

A customer delegated to your tenant with **Azure Lighthouse** needs none of this: give the shared SPN the Azure roles
in the delegation and it scans those subscriptions like its own (Graph-based tools then only see your home tenant).

## Per-tool SPN (optional)

A tool can scan as its own service principal (Settings → SPN override, or `<TOOL_ID>_AZURE_CLIENT_ID` and friends
in `.env`). It needs only what that tool uses from the lists above, for example Cost Management Reader for the cost
tools or `Application.Read.All` for app secret expiry.

## Web app's own data

The web app's system-assigned identity also gets, on the dashboard's own resources only:

| Role | On | Used for |
| --- | --- | --- |
| Storage Blob Data Contributor | The history storage account | Scan results and run history (`create_history_storage`) |
| Key Vault Secrets Officer | The dashboard's secret vault | Client secrets entered in Settings (`create_secret_vault`) |

People in `secret_vault_admin_ids` also get Key Vault Secrets Officer on the secret vault, to see or fix a stored
secret in the portal. Nobody else can read those secrets.

## SSO app

The app registration people sign in with. It reads no data: it has the delegated permissions `openid` and
`profile` (admin consent, `grant_sso_consent`), the app roles Admin, User, Admin-&lt;key&gt; and User-&lt;key&gt;,
and a federated credential for the user-assigned identity, so it has no secret.

## Whoever runs Terraform

A person or a pipeline service principal in the home tenant:

| Needs | For |
| --- | --- |
| Contributor on the subscription | The resource group, App Service, storage account, key vault and network |
| Owner, User Access Administrator or Role Based Access Control Administrator | Role assignments: on each `shared_spn_access` scope, and on the dashboard's own resource group (storage, secret vault) |
| Rights to register resource providers on the subscription | `Microsoft.Web`, `Microsoft.Storage`, `Microsoft.ManagedIdentity`, `Microsoft.KeyVault` (or remove `resource_providers_to_register` from `versions.tf` if they are already registered) |
| Network Contributor (subscription or existing VNet) | `private_network = true` |
| Entra: Application Administrator | The SSO app registration (`create_sso_app`) |
| Entra: Privileged Role Administrator or Global Administrator | The Graph permissions for the shared SPN (`grant_graph_permissions`; set `false` and ask an admin otherwise) |
| Entra: Groups Administrator (or `Group.ReadWrite.All`) | Role groups (`create_role_groups`) |
| Graph application permission `DelegatedPermissionGrant.ReadWrite.All` (pipeline SP only; a person needs Application Administrator) | Admin consent for sign-in (`grant_sso_consent`) |

For a pipeline service principal, the Entra roles above are directory roles assigned to it (or the matching Graph
application permissions: `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `Group.ReadWrite.All`).
Terraform never writes a secret into the vault, so it needs no access to the vault's data, and it never touches a
customer tenant.
