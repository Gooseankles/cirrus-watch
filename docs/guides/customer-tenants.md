# Customer tenants

One dashboard can scan other organizations' tenants as well as its own, so it is hosted in one place. Each tenant
gets a tab at the top of the page ("All tenants" shows them together, with the tenant next to each row), its own
storage container, and its own roles ([Sign-in and roles](sign-in-and-roles.md)). Its scans run in that tenant as that tenant's app registration; the
home tenant keeps using the shared SPN. Running it for your own tenant only? Then nothing on this page is needed;
see [Single tenant or several](../hld.md#single-tenant-or-several).

Each customer tenant has its own app registration, made there by hand, with a client secret. Give that app the
Graph application permissions (with admin consent) and Reader and Cost Management Reader on the
subscriptions (step by step in [docs/permissions.md](../permissions.md#customer-tenant-app-other-tenants)), put
its client ID in Terraform's `customers` (`client_id`) or in Settings, and paste its secret in Settings → Customer
tenants → Edit (only there, so it never lands in the Terraform state; it is kept in the key vault, and the page
shows whether one is set, never the value). `terraform output customer_onboarding` prints every step per customer; Terraform never
touches a customer tenant. A secretless sign-in is not possible here: Entra does not let an app trust a managed
identity of another tenant.

Customers come from Terraform (`customers`, passed to the app as `DASHBOARD_TENANTS`); Settings → Customer tenants
lists them, tests each one and can change the client ID, name or subscriptions or turn scanning off. On a
customer's tab, Settings shows that customer's own tool settings (required tags, warning days, policy probes,
cost thresholds and the like); blank = the Home value. Sign-in, storage and the per-tool SPNs are set on the Home
tab only. A tenant added
only in Settings works, but has no Admin-&lt;key&gt; / User-&lt;key&gt; roles, so only global Admin and User see it. A customer tenant delegated to your tenant with Azure Lighthouse
can instead be scanned by the home identity like any other subscription; then it does not need to be added here.

## Remove a customer

Settings → Customer tenants → **Remove** (global `Admin` only; a customer's own `Admin-<key>` cannot) deletes
everything the dashboard holds for that tenant, with nothing kept. The dialog lists it, says it cannot be undone and
asks for the tenant's key typed back before the button works. What goes:

- its client secret, deleted from the key vault and purged from the vault's soft-delete bin (without a vault, from
  `tenants.json`);
- its notification link (also a secret, purged the same way) and anything waiting in the retry queue;
- its storage container `dashboard-<key>` (on disk `DATA_DIR/tenants/<key>`) with the scan results, the history,
  accepted and snoozed findings, cost history and cleanup savings;
- its own tool settings and its lines in the activity log;
- the tenant itself: it leaves the list, the tabs and every page at once, and a scan still running writes nothing
  more for it.

The audit log keeps one line: who removed which tenant, when, and what was deleted or could not be. If a step fails
(storage says no, the vault is unreachable) the rest still run, and the page names what to finish by hand. If the
vault's purge protection is on (`secret_vault_purge_protection`), the secret is deleted but the vault keeps it for
the soft-delete period; the page says so, with the number of days.

What the dashboard cannot delete:

- **The roles and groups in Entra.** Terraform made them, and the app only reads Entra. For a tenant from
  Terraform, the page says: also remove the key from `customers` and apply; that deletes its roles, groups and the
  (now empty) container. Until then the app ignores the tenant: it is not scanned, shown or written to, its
  container is not made again, and Settings lists it under "Removed, waiting for Terraform" with **Undo**. Undo
  brings the tenant back to the list and the scans; what was deleted stays deleted. Once the key is gone from
  `DASHBOARD_TENANTS` the entry clears itself at the next start.
- **The customer's own app registration.** It is in their tenant; ask them to delete it (or at least its secret).

**Reset** on a Terraform tenant is different: it only drops the changes made to it in Settings (name, client ID,
subscriptions, the secret) and keeps the tenant and its data.

Related: [permissions for a customer tenant app](../permissions.md#customer-tenant-app-other-tenants),
[architecture: customer tenants](../architecture.md#6-customer-tenants), [ADR 0005](../adr/0005-customer-tenants-own-app-registration.md).
