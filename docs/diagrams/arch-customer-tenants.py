# Customer tenants: what Terraform makes for a customer, the secret an admin pastes, and how the dashboard
# reaches the customer's tenant. Rendered by npm run diagrams -- arch-customer-tenants.
from diagrams.azure.compute import AppServices
from diagrams.azure.general import StorageContainer, Subscriptions, Usericon
from diagrams.azure.identity import AppRegistrations
from diagrams.azure.security import KeyVaults
from diagrams.onprem.iac import Terraform

from _style import group, icon, link, picture, text

with picture(__file__):
    tf = icon(Terraform, "Terraform", "customers = {...}")
    admin = icon(Usericon, "Admin in Settings")
    with group("Home tenant", "tenant"):
        app = icon(AppServices, "Dashboard")
        kv = icon(KeyVaults, "Key vault", "dashboard-… secrets")
        st = icon(StorageContainer, "Storage", "dashboard-<key>")
        roles = text("App roles", "Admin-<key>, User-<key>")
    with group("Customer tenant <key>", "tenant"):
        capp = icon(AppRegistrations, "App registration (made by hand)", "Graph app permissions + admin consent")
        csubs = icon(Subscriptions, "Subscriptions", "Reader, Cost Management Reader",
                     "(Key Vault Reader only for the item check)")

    tf >> link("DASHBOARD_TENANTS\n(no secrets)") >> app
    tf >> link() >> st
    tf >> link() >> roles
    admin >> link("client secret") >> kv
    kv >> link() >> app
    app >> link("client secret credential") >> capp
    capp >> link() >> csubs
