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

Related: [permissions for a customer tenant app](../permissions.md#customer-tenant-app-other-tenants),
[architecture: customer tenants](../architecture.md#6-customer-tenants), [ADR 0005](../adr/0005-customer-tenants-own-app-registration.md).
