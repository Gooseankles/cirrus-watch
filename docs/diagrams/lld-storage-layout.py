# Storage layout: the files in each tenant's container (or folder), what stays in DATA_DIR, and the
# secret names in the vault. Rendered by npm run diagrams -- lld-storage-layout.
from diagrams.azure.general import FolderBlank, StorageContainer
from diagrams.azure.security import KeyVaults
from diagrams.azure.storage import StorageAccounts

from _style import group, order, picture, row, text

with picture(__file__):
    with group("History storage: blob containers (STORAGE_ACCOUNT_URL)\nor folders under DATA_DIR", "tenant",
               icon=StorageAccounts):
        with group("Home tenant: container dashboard\n(or DATA_DIR itself)", "plain", icon=StorageContainer):
            h1 = text("findings/<tool>.json", "latest result and last error")
            h2 = text("history/<tool>/index.json\nhistory/<tool>/<ranAt>.json")
            h3 = text("suppressions/<tool>.json", "accepted and snoozed")
            h4 = text("cost/index.json\ncost/<subscription>.json")
        with group("Customer <key>: container dashboard-<key>\n(or DATA_DIR/tenants/<key>)", "plain",
                   icon=StorageContainer):
            c1 = text("The same files,", "only that tenant's data")
    with group("DATA_DIR (/home/data on App Service)", "plain", icon=FolderBlank):
        d1 = text("settings.json\ntenant-settings.json\ntenants.json")
        d2 = text("notify.json (links)\nnotify-queue.json")
        d3 = text("sessions/\nsession-secret")
        d4 = text("monitor.json (48 h of load)\neol-dates.json, cve-feeds.json")
        d5 = text("logs/runs.jsonl", "(activity log)")
        d6 = text("logs/audit.jsonl", "(audit log)")
    with group("Key vault (SECRET_VAULT_URL)", "plain", icon=KeyVaults):
        k1 = text("dashboard-<kind>-<key>-<hash>", "customer secrets, SPN overrides,", "notification links")

    row(h1, h2)
    row(h3, h4)
    row(d1, d2)
    row(d3, d4)
    row(d5, d6)
    order(h1, h3, c1, d1, d3, d5, k1)
    order(h2, h4)
    order(d2, d4, d6)
