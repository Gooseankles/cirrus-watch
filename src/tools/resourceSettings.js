// Risky settings on common services: access keys and admin accounts still
// on, plain HTTP and FTP, open storage firewalls, AKS without Entra sign-in,
// remote debugging. Each finding follows a PSRule for Azure rule. Key Vault,
// TLS versions and public blob access have their own scans. Reader is enough.
const { resourceGraphQuery, armGet } = require("../armClient");
const { mapLimit, runChecks, itemErrors } = require("./util");
const { ruleFinding, rules } = require("./psrule");

const TOOL_ID = "resource-settings";
const CONCURRENCY = 6;
const MAX_SITES = 500; // web apps whose site config is read

const R = rules({
  secureTransfer: "Azure.Storage.SecureTransfer|Important|Security",
  storageFirewall: "Azure.Storage.Firewall|Important|Security",
  storageKeys: "Azure.Storage.LocalAuth|Important|Security",
  sqlAad: "Azure.SQL.AAD|Critical|Security",
  sqlAadOnly: "Azure.SQL.AADOnly|Important|Security",
  https: "Azure.AppService.UseHTTPS|Important|Security",
  remoteDebug: "Azure.AppService.RemoteDebug|Important|Security",
  ftp: "Azure.AppService.WebSecureFtp|Important|Security",
  acrAdmin: "Azure.ACR.AdminUser|Critical|Security",
  acrAnonymous: "Azure.ACR.AnonymousAccess|Important|Security",
  aksLocal: "Azure.AKS.LocalAccounts|Important|Security",
  aksManagedAad: "Azure.AKS.ManagedAAD|Important|Security",
  aksRbac: "Azure.AKS.AzureRBAC|Important|Security",
  aksIps: "Azure.AKS.AuthorizedIPs|Important|Security",
  aksUpgrade: "Azure.AKS.AutoUpgrade|Important|Operational Excellence",
  redisPlain: "Azure.Redis.NonSslPort|Critical|Security",
  cosmosKeys: "Azure.Cosmos.NoSQLLocalAuth|Critical|Security",
  cosmosMetadata: "Azure.Cosmos.DisableMetadataWrite|Important|Security",
  serviceBusKeys: "Azure.ServiceBus.DisableLocalAuth|Important|Security",
  eventHubKeys: "Azure.EventHub.DisableLocalAuth|Important|Security",
  appConfigKeys: "Azure.AppConfig.DisableLocalAuth|Important|Security",
});

const q = (kql) => resourceGraphQuery(kql, { toolId: TOOL_ID });
const off = (v) => v === false || /^false$/i.test(String(v));
const on = (v) => v === true || /^true$/i.test(String(v));

async function storage() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.storage/storageaccounts'
    | where tostring(tags['ms-resource-usage']) != 'azure-cloud-shell'
    | project id, name, resourceGroup, subscriptionId, https = properties.supportsHttpsTrafficOnly, sharedKey = properties.allowSharedKeyAccess,
        network = tostring(properties.publicNetworkAccess), defaultAction = tostring(properties.networkAcls.defaultAction)`);
  const out = [];
  for (const r of rows) {
    if (off(r.https)) out.push(ruleFinding(r, "cfg-storage-http", "Storage", R.secureTransfer, "Accepts plain HTTP. Turn on \"Secure transfer required\""));
    if (!/^disabled$/i.test(r.network) && !/^deny$/i.test(r.defaultAction)) out.push(ruleFinding(r, "cfg-storage-no-firewall", "Storage", R.storageFirewall, "Reachable from every network. Set the firewall to selected networks or use a private endpoint"));
    if (!off(r.sharedKey)) out.push(ruleFinding(r, "cfg-storage-keys", "Storage", R.storageKeys, "Access keys and SAS tokens signed with them still work, and they never expire on their own. Use Entra ID and turn off shared key access"));
  }
  return out;
}

async function sql() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.sql/servers' and kind !contains 'analytics'
    | project id, name, resourceGroup, subscriptionId, adminType = tostring(properties.administrators.administratorType),
        aadOnly = properties.administrators.azureADOnlyAuthentication`);
  const out = [];
  for (const r of rows) {
    if (!/^activedirectory$/i.test(r.adminType)) out.push(ruleFinding(r, "cfg-sql-no-entra-admin", "SQL", R.sqlAad, "No Microsoft Entra admin: only SQL logins with passwords can manage the server. Set an Entra group as admin"));
    else if (!on(r.aadOnly)) out.push(ruleFinding(r, "cfg-sql-sql-logins", "SQL", R.sqlAadOnly, "SQL logins with passwords still work next to Entra ID. Turn on Microsoft Entra-only authentication"));
  }
  return out;
}

async function appService() {
  const sites = await q(`Resources
    | where type =~ 'microsoft.web/sites'
    | project id, name, resourceGroup, subscriptionId, kind = tostring(kind), httpsOnly = properties.httpsOnly`);
  const out = [];
  for (const s of sites) if (!on(s.httpsOnly)) out.push(ruleFinding(s, "cfg-app-http", "App Service", R.https, "Answers on plain HTTP. Turn on \"HTTPS only\""));
  const checked = sites.slice(0, MAX_SITES);
  const failures = await mapLimit(checked, CONCURRENCY, async (s) => {
    const cfg = (await armGet(`https://management.azure.com${s.id}/config/web?api-version=2023-12-01`, TOOL_ID)).properties || {};
    if (on(cfg.remoteDebuggingEnabled)) out.push(ruleFinding(s, "cfg-app-remote-debug", "App Service", R.remoteDebug, `Remote debugging is on${cfg.remoteDebuggingVersion ? ` (${cfg.remoteDebuggingVersion})` : ""}: it opens extra ports. Turn it off when nobody is debugging`));
    if (/^allallowed$/i.test(cfg.ftpsState)) out.push(ruleFinding(s, "cfg-app-ftp", "App Service", R.ftp, "Plain FTP is allowed, so deploy passwords cross the network unencrypted. Set FTP to \"FTPS only\" or \"Disabled\""));
  });
  return [...out, ...itemErrors(TOOL_ID, "sites", "web apps", failures, checked.length)];
}

async function registries() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.containerregistry/registries'
    | project id, name, resourceGroup, subscriptionId, admin = properties.adminUserEnabled, anonymous = properties.anonymousPullEnabled`);
  const out = [];
  for (const r of rows) {
    if (on(r.admin)) out.push(ruleFinding(r, "cfg-acr-admin", "Container registry", R.acrAdmin, "The admin user is on: one shared password with push and pull rights. Turn it off and use Entra ID or tokens"));
    if (on(r.anonymous)) out.push(ruleFinding(r, "cfg-acr-anonymous", "Container registry", R.acrAnonymous, "Anyone who can reach the registry can pull images without signing in"));
  }
  return out;
}

async function aks() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.containerservice/managedclusters'
    | project id, name, resourceGroup, subscriptionId, localOff = properties.disableLocalAccounts, managedAad = properties.aadProfile.managed,
        azureRbac = properties.aadProfile.enableAzureRBAC, privateCluster = properties.apiServerAccessProfile.enablePrivateCluster,
        ipRanges = properties.apiServerAccessProfile.authorizedIPRanges, channel = tostring(properties.autoUpgradeProfile.upgradeChannel)`);
  const out = [];
  for (const r of rows) {
    if (!on(r.localOff)) out.push(ruleFinding(r, "cfg-aks-local-accounts", "AKS", R.aksLocal, "Local accounts are on: a cluster-admin kubeconfig works with no Entra sign-in and cannot be traced to a person"));
    if (!on(r.managedAad)) out.push(ruleFinding(r, "cfg-aks-no-entra", "AKS", R.aksManagedAad, "Microsoft Entra integration is off: people sign in with cluster certificates, not their Entra account"));
    else if (!on(r.azureRbac)) out.push(ruleFinding(r, "cfg-aks-k8s-rbac", "AKS", R.aksRbac, "Kubernetes access is granted inside the cluster, not with Azure RBAC, so it does not show in Azure role assignments"));
    if (!on(r.privateCluster) && !(Array.isArray(r.ipRanges) && r.ipRanges.length)) out.push(ruleFinding(r, "cfg-aks-open-api", "AKS", R.aksIps, "The API server is public and accepts any IP address. Set authorized IP ranges or make it a private cluster"));
    if (!r.channel || /^none$/i.test(r.channel)) out.push(ruleFinding(r, "cfg-aks-no-auto-upgrade", "AKS", R.aksUpgrade, "No automatic upgrade channel: the cluster falls behind on patches until someone upgrades it by hand"));
  }
  return out;
}

const NOT_NOSQL = /^(enablemongo|enablecassandra|enabletable|enablegremlin)$/i;

async function dataServices() {
  const rows = await q(`Resources
    | where type in~ ('microsoft.cache/redis', 'microsoft.documentdb/databaseaccounts', 'microsoft.servicebus/namespaces', 'microsoft.eventhub/namespaces', 'microsoft.appconfiguration/configurationstores')
    | project id, name, resourceGroup, subscriptionId, type = tolower(type), kind = tostring(kind), nonSsl = properties.enableNonSslPort,
        localOff = properties.disableLocalAuth, metadataLocked = properties.disableKeyBasedMetadataWriteAccess, capabilities = properties.capabilities`);
  const out = [];
  const keys = { "microsoft.servicebus/namespaces": ["cfg-servicebus-keys", R.serviceBusKeys, "Service Bus"], "microsoft.eventhub/namespaces": ["cfg-eventhub-keys", R.eventHubKeys, "Event Hubs"], "microsoft.appconfiguration/configurationstores": ["cfg-appconfig-keys", R.appConfigKeys, "App Configuration"] };
  for (const r of rows) {
    if (r.type === "microsoft.cache/redis") {
      if (on(r.nonSsl)) out.push(ruleFinding(r, "cfg-redis-plain-port", "Redis", R.redisPlain, "The non-TLS port 6379 is open: data and the access key cross the network unencrypted"));
    } else if (r.type === "microsoft.documentdb/databaseaccounts") {
      const nosql = !/mongodb/i.test(r.kind) && !(r.capabilities || []).some((c) => NOT_NOSQL.test(c && c.name));
      if (nosql && !on(r.localOff)) out.push(ruleFinding(r, "cfg-cosmos-keys", "Cosmos DB", R.cosmosKeys, "Account keys still work: anyone with a key reads and writes all data. Use Entra ID and turn off local auth"));
      if (!on(r.metadataLocked)) out.push(ruleFinding(r, "cfg-cosmos-metadata", "Cosmos DB", R.cosmosMetadata, "Account keys can change databases and containers (throughput, indexes, deletes). Turn on \"disable key-based metadata write access\""));
    } else if (keys[r.type] && !on(r.localOff)) {
      const [kind, rule, label] = keys[r.type];
      out.push(ruleFinding(r, kind, "Messaging and config", rule, `${label} access keys and SAS tokens still work. Use Entra ID and turn off local auth`));
    }
  }
  return out;
}

function run() {
  return runChecks(TOOL_ID, {
    "Storage accounts": storage,
    "SQL servers": sql,
    "App Service": appService,
    "Container registries": registries,
    "AKS clusters": aks,
    "Redis, Cosmos DB and messaging": dataServices,
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Resource settings",
  schedule: "45 3 * * *", // daily at 03:45
  run,
  _test: { R },
};
