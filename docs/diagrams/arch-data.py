# Data: the containers in the storage account and the files in each, what stays on the App Service disk,
# and the vault. Rendered by npm run diagrams -- arch-data.
from diagrams.azure.general import FolderBlank, StorageContainer
from diagrams.azure.security import KeyVaults
from diagrams.azure.storage import StorageAccounts

from _style import group, icon, link, order, picture, text

with picture(__file__):
    with group("Storage account", "tenant", icon=StorageAccounts):
        c0 = icon(StorageContainer, "dashboard/", "(home)")
        c1 = icon(StorageContainer, "dashboard-<key>/", "(each customer)")
    with group("In each container", "plain") as files:
        f1 = text("findings/<tool>.json", "latest run + last error")
        f2 = text("history/<tool>/index.json", "counts per run")
        f3 = text("history/<tool>/<ranAt>.json", "full snapshot")
        f4 = text("suppressions/<tool>.json", "accepted, snoozed")
        f5 = text("cost history documents")
    with group("/home/data on App Service", "plain", icon=FolderBlank):
        d1 = text("settings.json, tenants.json", "(no secrets when the vault is on)")
        d2 = text("sessions/")
        d3 = text("logs/runs.jsonl, logs/audit.jsonl")
    kv = icon(KeyVaults, "Key vault", "dashboard-* secrets")

    c0 - link(lhead=files.name) - f1
    c1 - link(lhead=files.name) - f1
    order(f1, f2, f3, f4, f5)
    order(c1, d1, d2, d3, kv)
