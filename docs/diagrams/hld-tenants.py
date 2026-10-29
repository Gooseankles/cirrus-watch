# Tenants: the home tenant and each customer tenant, each with its own identity and container.
# Rendered by npm run diagrams -- hld-tenants.
from diagrams.azure.compute import AppServices
from diagrams.azure.general import StorageContainer, Subscriptions
from diagrams.azure.identity import AppRegistrations, ManagedIdentities, Users

from _style import group, icon, link, order, picture

with picture(__file__):
    ppl = icon(Users, "People")
    with group("Cirrus Watch (one installation)"):
        app = icon(AppServices, "Web app")
    with group("Home tenant", "tenant"):
        hid = icon(ManagedIdentities, "Managed identity", "(no secret)")
        hsubs = icon(Subscriptions, "Subscriptions and Entra")
    with group("Customer A tenant", "tenant"):
        aapp = icon(AppRegistrations, "Their app registration", "(client secret)")
        asubs = icon(Subscriptions, "Subscriptions and Entra")
    with group("Customer B tenant", "tenant"):
        bapp = icon(AppRegistrations, "Their app registration", "(client secret)")
        bsubs = icon(Subscriptions, "Subscriptions and Entra")
    sh = icon(StorageContainer, "container dashboard")
    sa = icon(StorageContainer, "container dashboard-a")
    sb = icon(StorageContainer, "container dashboard-b")

    ppl >> link("roles decide which tenants\nand areas they see") >> app
    app >> link() >> hid >> link() >> hsubs
    app >> link("secret from Key Vault") >> aapp >> link() >> asubs
    app >> link("secret from Key Vault") >> bapp >> link() >> bsubs
    app >> link() >> sh
    app >> link() >> sa
    app >> link() >> sb
    order(sh, sa, sb)
