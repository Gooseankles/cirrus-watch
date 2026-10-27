// Builds public/icons/azure-icons.json from Microsoft's Azure architecture icons.
//
// Usage: node scripts/build-azure-icons.mjs <folder with the unpacked Azure_Public_Service_Icons zip>
// Download: https://learn.microsoft.com/azure/architecture/icons/ (V24 when this was written).
// Only the icons the Architecture drawing uses are kept (see public/icons/NOTICE.md for the terms).
// The draw.io paths are draw.io's own copies (img/lib/azure2/...), so a .drawio file needs no icon files.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const VERSION = "V24";
// Short name of the tile (TYPES in public/architecture.js) -> [icon number in the zip, draw.io azure2 path].
const MAP = {
  VM: ["10021", "compute/Virtual_Machine.svg"],
  VMSS: ["10034", "compute/VM_Scale_Sets.svg"],
  AKS: ["10023", "compute/Kubernetes_Services.svg"],
  ACI: ["10104", "compute/Container_Instances.svg"],
  CA: ["02884", "other/Worker_Container_App.svg"],
  CAE: ["02989", "other/Container_App_Environments.svg"],
  ACR: ["10105", "containers/Container_Registries.svg"],
  AVD: ["00327", "other/Windows_Virtual_Desktop.svg"],
  BAT: ["10031", "compute/Batch_Accounts.svg"],
  ARC: ["01710", "management_governance/Arc_Machines.svg"],
  APP: ["10035", "app_services/App_Services.svg"],
  FN: ["10029", "compute/Function_Apps.svg"],
  PLAN: ["00046", "app_services/App_Service_Plans.svg"],
  SWA: ["01007", "preview/Static_Apps.svg"],
  APIM: ["10042", "app_services/API_Management_Services.svg"],
  LOGIC: ["02631", "integration/Logic_Apps.svg"],
  SIGR: ["10052", "web/SignalR.svg"],
  CDN: ["10073", "networking/Front_Doors.svg"],
  AFD: ["10073", "networking/Front_Doors.svg"],
  ST: ["10086", "storage/Storage_Accounts.svg"],
  SQL: ["10132", "databases/SQL_Server.svg"],
  SQLDB: ["10130", "databases/SQL_Database.svg"],
  POOL: ["10134", "databases/SQL_Elastic_Pools.svg"],
  SQLMI: ["10136", "databases/SQL_Managed_Instance.svg"],
  COS: ["10121", "databases/Azure_Cosmos_DB.svg"],
  PG: ["10131", "databases/Azure_Database_PostgreSQL_Server.svg"],
  MY: ["10122", "databases/Azure_Database_MySQL_Server.svg"],
  RED: ["10137", "databases/Cache_Redis.svg"],
  ADF: ["10126", "databases/Data_Factory.svg"],
  SYN: ["00606", "analytics/Azure_Synapse_Analytics.svg"],
  DBX: ["10787", "analytics/Azure_Databricks.svg"],
  EH: ["00039", "analytics/Event_Hubs.svg"],
  SB: ["10836", "integration/Service_Bus.svg"],
  EG: ["10206", "integration/Event_Grid_Topics.svg"],
  EGS: ["10206", "integration/System_Topic.svg"],
  SRCH: ["10044", "app_services/Search_Services.svg"],
  AI: ["10162", "ai_machine_learning/Cognitive_Services.svg"],
  ML: ["10166", "ai_machine_learning/Machine_Learning.svg"],
  VNET: ["10061", "networking/Virtual_Networks.svg"],
  FW: ["10084", "networking/Firewalls.svg"],
  FWP: ["00272", "networking/Azure_Firewall_Policy.svg"],
  AGW: ["10076", "networking/Application_Gateways.svg"],
  WAF: ["10362", "networking/Web_Application_Firewall_Policies_WAF.svg"],
  LB: ["10062", "networking/Load_Balancers.svg"],
  BAS: ["02422", "networking/Bastions.svg"],
  GW: ["10063", "networking/Virtual_Network_Gateways.svg"],
  SITE: ["10077", "networking/Local_Network_Gateways.svg"],
  ER: ["10079", "networking/ExpressRoute_Circuits.svg"],
  PE: ["02579", "networking/Private_Endpoint.svg"],
  PLS: ["01105", "networking/Private_Link_Service.svg"],
  NAT: ["10310", "networking/NAT.svg"],
  DNS: ["10064", "networking/DNS_Zones.svg"],
  PDNS: ["10064", "networking/DNS_Zones.svg"],
  DNSR: ["02882", "networking/DNS_Private_Resolver.svg"],
  TM: ["10065", "networking/Traffic_Manager_Profiles.svg"],
  HUB: ["00860", "networking/Virtual_WAN_Hub.svg"],
  ARS: ["02496", "networking/Virtual_Router.svg"], // Route Server
  VWAN: ["10353", "networking/Virtual_WANs.svg"],
  DDOS: ["10072", "networking/DDoS_Protection_Plans.svg"],
  PIPP: ["10069", "networking/Public_IP_Prefixes.svg"], // its own icon (10372) embeds a picture
  KV: ["10245", "security/Key_Vaults.svg"],
  ID: ["10227", "identity/Managed_Identities.svg"],
  LAW: ["00009", "analytics/Log_Analytics_Workspaces.svg"],
  APPI: ["00012", "devops/Application_Insights.svg"],
  AUTO: ["00022", "management_governance/Automation_Accounts.svg"],
  RSV: ["00017", "management_governance/Recovery_Services_Vaults.svg"],
  BV: ["02361", "other/Backup_Vault.svg"],
  AG: ["00001", "management_governance/Monitor.svg"],
  NIC: ["10080", "networking/Network_Interfaces.svg"],
  DISK: ["10032", "compute/Disks.svg"],
  SNAP: ["10026", "compute/Disks_Snapshots.svg"],
  PIP: ["10069", "networking/Public_IP_Addresses.svg"],
  NSG: ["10067", "networking/Network_Security_Groups.svg"],
  RT: ["10082", "networking/Route_Tables.svg"],
  NW: ["10066", "networking/Network_Watcher.svg"],
  CONN: ["10081", "networking/Connections.svg"],
  LINK: ["00427", "networking/Private_Link.svg"],
  EXT: ["10799", "general/Extensions.svg"],
  AVS: ["10025", "compute/Availability_Sets.svg"],
  SSH: ["00412", "other/SSH_Keys.svg"],
  RPC: ["02818", "compute/Restore_Points_Collections.svg"],
  ALRT: ["00002", "management_governance/Alerts.svg"],
  DCR: ["01857", "other/Data_Collection_Rules.svg"],
  DCE: ["01857", "other/Data_Collection_Rules.svg"],
  SOL: ["00021", "management_governance/Solutions.svg"],
  DASH: ["10015", "general/Dashboard.svg"],
};

const root = process.argv[2];
if (!root) throw new Error("Give the folder of the unpacked icon zip");
// A few numbers are shared by two different icons: the name says which one.
const PICK = { 10137: "Cache-Redis", 10227: "Managed-Identities", 10787: "Azure-Databricks" };
const files = new Map();
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/^\d+-icon-service-.*\.svg$/.test(name)) {
      const [num] = name.split("-");
      const icon = name.replace(/^\d+-icon-service-|\.svg$/g, "");
      if (PICK[num] && PICK[num] !== icon) continue;
      if (files.has(num) && files.get(num).icon !== icon) files.get(num).other = icon;
      else files.set(num, { ...files.get(num), p, icon });
    }
  }
};
walk(root);

const icons = {};
for (const num of new Set(Object.values(MAP).map(([n]) => n))) {
  const f = files.get(num);
  if (!f) throw new Error(`Icon ${num} is not in ${root} (renamed in a newer set?)`);
  if (f.other) throw new Error(`Icon ${num} has two names (${f.icon}, ${f.other}): add it to PICK`);
  const p = f.p;
  const svg = readFileSync(p, "utf8");
  if (/<image|xlink:href/.test(svg)) throw new Error(`Icon ${num} embeds a picture`);
  const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1] || "0 0 18 18";
  // The inside of the file, without its title; gradient ids are unique per icon and stay as they are.
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>[\s\S]*?<\/title>/g, "").replace(/\s*\n\s*/g, " ").trim();
  icons[num] = { name: p.split(/[\\/]/).pop().replace(/^\d+-icon-service-|\.svg$/g, ""), vb, body };
}
const out = { source: `Microsoft Azure architecture icons ${VERSION}`, terms: "https://learn.microsoft.com/azure/architecture/icons/", icons, map: MAP };
writeFileSync(new URL("../public/icons/azure-icons.json", import.meta.url), JSON.stringify(out));
console.log(`${Object.keys(icons).length} icons for ${Object.keys(MAP).length} tile kinds`);
