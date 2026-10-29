# Network: access restrictions in front, the optional VNet with private endpoints behind, and the public
# endpoints the app still reaches. Rendered by npm run diagrams -- arch-network.
from diagrams.azure.compute import AppServices
from diagrams.azure.identity import Security, Users
from diagrams.azure.network import DNSPrivateZones, PrivateEndpoint, Subnets, VirtualNetworks
from diagrams.azure.security import KeyVaults
from diagrams.azure.storage import StorageAccounts
from diagrams.onprem.network import Internet

from _style import group, icon, link, picture, same_rank

with picture(__file__):
    user = icon(Users, "Allowed IPs / subnets")
    fe = icon(Security, "App Service front end", "access restrictions, TLS 1.2+")
    app = icon(AppServices, "Web app")
    with group("VNet (private_network)", "tenant", icon=VirtualNetworks):
        snapp = icon(Subnets, "snet-app", "delegated to App Service")
        dns = icon(DNSPrivateZones, "Private DNS", "privatelink.blob.core.windows.net", "privatelink.vaultcore.azure.net")
        with group("snet-private-endpoints", icon=Subnets):
            pest = icon(PrivateEndpoint, "Private endpoint: blob")
            pekv = icon(PrivateEndpoint, "Private endpoint: vault")
    st = icon(StorageAccounts, "Storage", "public access off")
    kv = icon(KeyVaults, "Key vault", "public access off")
    azure = icon(Internet, "ARM, Graph, Entra,\nDocker Hub, endoflife.date")

    user >> link("HTTPS 443") >> fe >> link() >> app
    app >> link("VNet integration") >> snapp
    snapp >> link() >> pest
    snapp >> link() >> pekv
    pest >> link() >> st
    pekv >> link() >> kv
    app >> link("public internet\n(or via VNet with vnet_route_all + NAT)") >> azure
    same_rank(snapp, dns)
