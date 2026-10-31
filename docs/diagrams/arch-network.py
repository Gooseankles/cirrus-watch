# Network: access restrictions in front, the optional VNet behind (storage and vault let in the app subnet through
# service endpoints by default; private endpoints are opt-in, dashed), the optional inbound private endpoint for the
# web app itself (app_private_endpoint, dashed), and the public endpoints the app still reaches. Rendered by npm run diagrams -- arch-network.
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
        snapp = icon(Subnets, "snet-app", "delegated to App Service", "service endpoints: Storage, KeyVault")
        dns = icon(DNSPrivateZones, "Private DNS (only with private endpoints)", "privatelink.blob.core.windows.net",
                   "privatelink.vaultcore.azure.net", "privatelink.azurewebsites.net", optional=True)
        with group("snet-private-endpoints (optional)", "optional", icon=Subnets):
            pest = icon(PrivateEndpoint, "Private endpoint: blob", 'private_access = "private_endpoint"', optional=True)
            pekv = icon(PrivateEndpoint, "Private endpoint: vault", 'private_access = "private_endpoint"', optional=True)
            peapp = icon(PrivateEndpoint, "Private endpoint: web app", "pe-<name>, optional: app_private_endpoint", optional=True)
    st = icon(StorageAccounts, "Storage", "firewall: deny all but snet-app")
    kv = icon(KeyVaults, "Key vault", "firewall: deny all but snet-app")
    azure = icon(Internet, "ARM, Graph, Entra,\nDocker Hub, endoflife.date,\nCISA KEV, FIRST EPSS,\nrdap.org and DNS (opt-in)")

    user >> link("HTTPS 443") >> fe >> link() >> app
    app >> link("VNet integration") >> snapp
    snapp >> link("service endpoint\n(default, free)") >> st
    snapp >> link("service endpoint") >> kv
    snapp >> link(dashed=True) >> pest
    snapp >> link(dashed=True) >> pekv
    pest >> link(dashed=True) >> st
    pekv >> link(dashed=True) >> kv
    app >> link("public internet\n(or via VNet with vnet_route_all + NAT)") >> azure
    vuser >> link("HTTPS 443", dashed=True) >> peapp
    app << link("private IP; public access\nthen denies all networks", dashed=True) << peapp
    same_rank(snapp, dns)
    same_rank(vuser, app)
    same_rank(pest, pekv, peapp)
