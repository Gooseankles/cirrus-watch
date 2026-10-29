# Identities in the worked example contoso-ops: the two managed identities of the web app, their roles,
# and where a customer's secret sits. Rendered by npm run diagrams -- lld-identities.
from diagrams.azure.compute import AppServices
from diagrams.azure.general import Code, Subscriptions
from diagrams.azure.identity import AppRegistrations, ManagedIdentities
from diagrams.azure.security import KeyVaults
from diagrams.azure.storage import StorageAccounts

from _style import group, icon, link, order, picture, row

with picture(__file__):
    with group("Web app contoso-ops", icon=AppServices):
        sys = icon(ManagedIdentities, "System-assigned identity", "(shared SPN)")
        uai = icon(ManagedIdentities, "User-assigned identity", "id-contoso-ops-sso")
    sso = icon(AppRegistrations, "Sign-in app registration", "Cirrus Watch (contoso-ops)")
    arm = icon(Subscriptions, "Subscriptions or\nmanagement group")
    msgraph = icon(Code, "Microsoft Graph")
    st = icon(StorageAccounts, "Storage account", "containers dashboard,", "dashboard-<key>")
    kv = icon(KeyVaults, "Key vault")
    cust = icon(AppRegistrations, "Customer's own app registration", "(in their tenant, client secret)")

    sys >> link("Reader,\nCost Management Reader") >> arm
    sys >> link("Graph application\npermissions") >> msgraph
    sys >> link("Storage Blob\nData Contributor") >> st
    sys >> link("Key Vault\nSecrets Officer") >> kv
    uai >> link("federated credential\n(token for\napi://AzureADTokenExchange)") >> sso
    kv >> link("holds the client secret of", dashed=True) >> cust
    row(arm, msgraph, st, kv, sso)
    order(kv, cust)
