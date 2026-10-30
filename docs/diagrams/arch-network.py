# Network: access restrictions in front, the optional VNet with private endpoints behind, the optional inbound
# private endpoint for the web app itself (app_private_endpoint, dashed), and the public endpoints the app still
# reaches. Rendered by npm run diagrams -- arch-network.
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
    vuser = icon(Users, "Users on the VNet", "VPN, ExpressRoute or peering", "optional: app_private_endpoint", optional=True)
    with group("VNet (private_network)", "tenant", icon=VirtualNetworks):
        snapp = icon(Subnets, "snet-app", "delegated to App Service")
        dns = icon(DNSPrivateZones, "Private DNS", "privatelink.blob.core.windows.net", "privatelink.vaultcore.azure.net",
                   "privatelink.azurewebsites.net (optional)")
        with group("snet-private-endpoints", icon=Subnets):
            pest = icon(PrivateEndpoint, "Private endpoint: blob")
            pekv = icon(PrivateEndpoint, "Private endpoint: vault")
            peapp = icon(PrivateEndpoint, "Private endpoint: web app", "pe-<name>, optional: app_private_endpoint", optional=True)
    st = icon(StorageAccounts, "Storage", "public access off")
    kv = icon(KeyVaults, "Key vault", "public access off")
    azure = icon(Internet, "ARM, Graph, Entra,\nDocker Hub, endoflife.date,\nCISA KEV, FIRST EPSS")

    user >> link("HTTPS 443") >> fe >> link() >> app
    app >> link("VNet integration") >> snapp
    snapp >> link() >> pest
    snapp >> link() >> pekv
    pest >> link() >> st
    pekv >> link() >> kv
    app >> link("public internet\n(or via VNet with vnet_route_all + NAT)") >> azure
    vuser >> link("HTTPS 443", dashed=True) >> peapp
    app << link("private IP; the public\naddress is then off", dashed=True) << peapp
    same_rank(snapp, dns)
    same_rank(vuser, app)
    same_rank(pest, pekv, peapp)
