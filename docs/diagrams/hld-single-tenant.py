# Single tenant: people, the web app, the home tenant, one container and the vault; customers come later.
# Rendered by npm run diagrams -- hld-single-tenant.
from diagrams.azure.compute import AppServices
from diagrams.azure.general import StorageContainer, Subscriptions
from diagrams.azure.identity import ManagedIdentities, Users, TenantProperties
from diagrams.azure.security import KeyVaults

from _style import group, icon, link, order, picture

with picture(__file__):
    ppl = icon(Users, "People")
    with group("Cirrus Watch (one installation)"):
        app = icon(AppServices, "Web app")
    with group("Home tenant (your own)", "tenant"):
        hid = icon(ManagedIdentities, "Managed identity", "(no secret)")
        hsubs = icon(Subscriptions, "Subscriptions and Entra")
    sh = icon(StorageContainer, "container dashboard")
    kv = icon(KeyVaults, "Key vault")
    later = icon(TenantProperties, "Customer tenant", optional=True)

    ppl >> link("roles: Admin, User, <Area>.Read\n(no tenant tabs)") >> app
    app >> link() >> hid >> link() >> hsubs
    app >> link("results and history") >> sh
    app >> link("secrets typed in Settings\n(SPN overrides, webhook links)") >> kv
    app >> link("customer tenants can be\nadded later, nothing is rebuilt", dashed=True) >> later
    order(sh, kv)
