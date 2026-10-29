# Identities: which identity reaches what, from the web app's two managed identities to the per-tool SPN
# and the customers' app registrations. Rendered by npm run diagrams -- arch-identities.
from diagrams.azure.compute import AppServices
from diagrams.azure.general import Code, Resource
from diagrams.azure.identity import ActiveDirectory, AppRegistrations, ManagedIdentities, TenantProperties
from diagrams.azure.security import KeyVaults
from diagrams.azure.storage import StorageAccounts

from _style import group, icon, link, order, picture, row, same_rank

with picture(__file__):
    tool = icon(AppRegistrations, "Per-tool SPN (optional)", "Settings → SPN override", optional=True)
    with group("Web app", icon=AppServices):
        sys = icon(ManagedIdentities, "System-assigned identity", "(the shared SPN)")
        usr = icon(ManagedIdentities, "User-assigned identity", "id-<name>-sso")

    arm = icon(Resource, "ARM", "Reader, Cost Management Reader", "(Key Vault Reader only", "for the item check)")
    gperm = icon(Code, "Graph application\npermissions", "(read-only)")
    st = icon(StorageAccounts, "History storage")
    kv = icon(KeyVaults, "Secret vault")
    ssoapp = icon(AppRegistrations, "Sign-in app\nregistration")
    login = icon(ActiveDirectory, "Entra sign-in", "(auth code + PKCE)")

    custapp = icon(AppRegistrations, "Customer app\nregistration", "(one per customer tenant)")
    carm = icon(TenantProperties, "Customer ARM + Graph")

    sys >> link() >> arm
    sys >> link() >> gperm
    sys >> link() >> st
    sys >> link() >> kv
    usr >> link("token for\napi://AzureADTokenExchange") >> ssoapp
    ssoapp >> link("client assertion,\nno secret") >> login
    tool >> link("instead of the shared\nSPN for that tool", dashed=True) >> arm
    custapp >> link("client secret\nfrom the vault") >> carm
    same_rank(tool, sys)
    row(arm, gperm, st, kv, ssoapp)
    same_rank(custapp, login)
    order(kv, custapp, carm)
