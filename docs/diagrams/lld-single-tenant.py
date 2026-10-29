# Single tenant in the worked example: what terraform apply makes without customers, and what a later
# apply with customers adds (dashed). Rendered by npm run diagrams -- lld-single-tenant.
from diagrams.azure.compute import AppServices
from diagrams.azure.general import ManagementGroups, ResourceGroups, StorageContainer
from diagrams.azure.identity import ActiveDirectory, AppRegistrations, EnterpriseApplications, Groups
from diagrams.azure.security import KeyVaults
from diagrams.azure.storage import StorageAccounts
from diagrams.onprem.iac import Terraform

from _style import group, icon, link, picture, row, same_rank, text

with picture(__file__):
    tf = icon(Terraform, "terraform apply", "(no customers)")
    with group("Entra ID (home tenant)", "tenant", icon=ActiveDirectory) as entra:
        gperm = icon(EnterpriseApplications, "Graph application permissions", "for the system-assigned identity")
        groups = icon(Groups, "One security group per role")
        sso = icon(AppRegistrations, "Sign-in app\nCirrus Watch (contoso-ops)", "roles Admin, User, <Area>.Read")
    with group("rg-contoso-ops", icon=ResourceGroups) as rg:
        web = icon(AppServices, "Web app contoso-ops", "system-assigned identity: scans, storage, vault",
                   "id-contoso-ops-sso: sign-in")
        kv = icon(KeyVaults, "Key vault", "secrets typed in Settings")
        st = icon(StorageAccounts, "Storage account", "one container: dashboard")
    scopes = icon(ManagementGroups, "Scan scopes (shared_spn_access)", "Reader, Cost Management Reader")
    with group("Later: customers = { acme = … }, apply again", "optional"):
        lcont = icon(StorageContainer, "container dashboard-acme", optional=True)
        lenv = text("app setting DASHBOARD_TENANTS", "(the web app restarts)", optional=True)
        lroles = text("roles and groups", "Admin-acme, User-acme, <Area>.Read-acme", optional=True)

    tf >> link(lhead=entra.name) >> sso
    tf >> link(lhead=rg.name) >> web
    groups >> link("assigned to the roles") >> sso
    gperm >> link(dashed=True) >> web
    web >> link("Key Vault\nSecrets Officer") >> kv
    web >> link("Storage Blob\nData Contributor") >> st
    web >> link() >> scopes
    st >> link("later gets", dashed=True) >> lcont
    web >> link("later gets", dashed=True) >> lenv
    sso >> link("later gets", dashed=True) >> lroles
    row(groups, sso, gperm)
    row(kv, st)
    same_rank(kv, scopes)
    row(lcont, lenv, lroles)
