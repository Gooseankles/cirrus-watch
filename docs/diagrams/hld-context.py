# Context: who and what Cirrus Watch talks to. Rendered by npm run diagrams -- hld-context.
from diagrams.azure.identity import ActiveDirectory, Users, TenantProperties
from diagrams.azure.general import Code, Resource
from diagrams.azure.storage import StorageAccounts
from diagrams.azure.security import KeyVaults
from diagrams.onprem.container import Docker
from diagrams.onprem.network import Internet
from diagrams.saas.chat import Teams

from _style import icon, link, picture, same_rank

with picture(__file__, direction="LR", ranksep="1.1"):
    people = icon(Users, "People", "(browser)")
    entra = icon(ActiveDirectory, "Entra ID")
    cw = icon(Docker, "Cirrus Watch", "(one container)")
    arm = icon(Resource, "Azure Resource Manager", "Resource Graph, Cost Management")
    msgraph = icon(Code, "Microsoft Graph", "(Entra ID)")
    cust = icon(TenantProperties, "Customer tenants", "(ARM + Graph, their own app)")
    chan = icon(Teams, "Teams, Slack, webhook", "or email (Graph)")
    st = icon(StorageAccounts, "Azure Storage", "(or local disk)")
    kv = icon(KeyVaults, "Azure Key Vault", "(or local file)")
    eol = icon(Internet, "endoflife.date")

    people >> link("HTTPS, Entra sign-in") >> cw
    entra >> link("ID token with roles") >> cw
    cw >> link("read") >> arm
    cw >> link("read") >> msgraph
    cw >> link("read") >> cust
    cw >> link("daily message") >> chan
    cw >> link("results and history") >> st
    cw >> link("secrets from Settings") >> kv
    cw >> link("end-of-support dates") >> eol
    same_rank(people, entra)
