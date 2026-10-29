# Azure resources: what the Terraform module makes in the subscription and in Entra ID, and the role
# assignments between them. Dashed = optional. Rendered by npm run diagrams -- arch-azure-resources.
from diagrams.azure.compute import AppServices
from diagrams.azure.general import ManagementGroups, ResourceGroups, ResourceLinked, StorageContainer, Subscriptions
from diagrams.azure.identity import ActiveDirectory, AppRegistrations, EnterpriseApplications, Groups, ManagedIdentities
from diagrams.azure.network import VirtualNetworks
from diagrams.azure.security import KeyVaults
from diagrams.azure.storage import StorageAccounts
from diagrams.azure.web import AppServicePlans

from _style import group, icon, link, picture, row

with picture(__file__):
    with group("Entra ID (home tenant)", "tenant", icon=ActiveDirectory):
        groups = icon(Groups, "Security groups", "one per app role", optional=True)
        sso = icon(AppRegistrations, "App registration", "Cirrus Watch (<name>)",
                   "app roles Admin, User, Admin-<key>, User-<key>,", "<Area>.Read(-<key>)")
        fic = icon(ResourceLinked, "Federated credential", "trusts id-<name>-sso")
        graphperm = icon(EnterpriseApplications, "Graph app role assignments", "to the web app's identity")
    with group("Azure subscription", "tenant", icon=Subscriptions):
        with group("rg-<name>", icon=ResourceGroups):
            uami = icon(ManagedIdentities, "User-assigned identity", "id-<name>-sso")
            asp = icon(AppServicePlans, "App Service plan", "asp-<name> (sku_name)")
            web = icon(AppServices, "Linux web app <name>", "identity: SystemAssigned + UserAssigned")
            st = icon(StorageAccounts, "Storage account st<name><suffix>", "shared keys off, TLS 1.2", optional=True)
            cont = icon(StorageContainer, "Containers", "dashboard, dashboard-<key> per customer", optional=True)
            kv = icon(KeyVaults, "Key vault kv<name><suffix>", "RBAC, purge protection optional", optional=True)
            vnet = icon(VirtualNetworks, "VNet + subnets", "private endpoints, private DNS", optional=True)
        scopes = icon(ManagementGroups, "Scan scopes", "management groups / subscriptions")

    groups >> link("assigned to app roles") >> sso
    sso >> link() >> fic
    fic >> link("subject = principal of", dashed=True) >> uami
    graphperm >> link("granted to", dashed=True) >> web
    uami >> link() >> web
    asp >> link() >> web
    web >> link("Storage Blob\nData Contributor") >> st
    st >> link() >> cont
    web >> link("Key Vault\nSecrets Officer") >> kv
    web << link(dashed=True) << vnet
    web >> link("Reader, Cost Management Reader\n(Key Vault Reader only\nfor the item check)") >> scopes
    row(groups, sso)
    row(fic, graphperm)
    row(uami, asp)
    row(st, kv, vnet, scopes)
