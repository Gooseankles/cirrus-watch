# Overview: the web app in its resource group, the Microsoft cloud APIs it talks to, people, Docker Hub
# and the customer tenants. Rendered by npm run diagrams -- arch-overview.
from diagrams.azure.compute import AppServices
from diagrams.azure.general import Code, Resource, ResourceGroups
from diagrams.azure.identity import ActiveDirectory, Users, TenantProperties
from diagrams.azure.security import KeyVaults
from diagrams.azure.storage import StorageAccounts
from diagrams.onprem.container import Docker

from _style import group, icon, link, order, picture

with picture(__file__):
    people = icon(Users, "People", "browser")
    hub = icon(Docker, "Docker Hub", "trozity/azure-ops-dashboard")
    with group("Home tenant", "tenant"):
        with group("Resource group rg-<name>", icon=ResourceGroups):
            app = icon(AppServices, "App Service", "Linux container", "Node.js + Express")
            st = icon(StorageAccounts, "Storage account", "scan results, history,", "cost history")
            kv = icon(KeyVaults, "Key vault", "secrets typed in Settings")
        with group("Microsoft cloud APIs", "plain"):
            entra = icon(ActiveDirectory, "Entra ID", "sign-in app + app roles")
            arm = icon(Resource, "Azure Resource Manager", "subscriptions")
            msgraph = icon(Code, "Microsoft Graph", "users, roles, policies")
    cust = icon(TenantProperties, "Customer tenants", "ARM + Graph")

    people >> link("HTTPS") >> app
    hub >> link("image pull") >> app
    app >> link("Entra token") >> st
    app >> link("Entra token") >> kv
    app >> link("sign-in: ID token\nwith roles claim") >> entra
    app >> link("scans: read only") >> arm
    app >> link("scans: read only") >> msgraph
    app >> link("scans: as each\ncustomer's app") >> cust
    order(st, kv)
    order(entra, arm, msgraph)
