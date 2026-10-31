"use strict";
/* Cirrus Watch front end: shell, routing, overview, logs, lookup, scan pages and run history.
   Every string that comes from the API goes through esc() before it is put into HTML. */

/* ---------- helpers ---------- */
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ICON_PATHS = {
  home: '<path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  wall: '<rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9.3" x2="21" y2="9.3"/><line x1="3" y1="14.7" x2="21" y2="14.7"/><line x1="9" y1="4" x2="9" y2="9.3"/><line x1="15" y1="9.3" x2="15" y2="14.7"/><line x1="9" y1="14.7" x2="9" y2="20"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  policy: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><polyline points="9 14 11 16 15 12"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  cost: '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  loader: '<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  app: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>',
  arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  report: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><polyline points="12 7 12 12 15 15"/>',
  crown: '<path d="M2 18h20"/><path d="M3 18l-1-11 6 5 4-8 4 8 6-5-1 11"/>',
  userx: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/>',
  badge: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2.5"/><line x1="13" y1="10" x2="18" y2="10"/><line x1="13" y1="14" x2="17" y2="14"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M5 16v-3h14v3"/><line x1="12" y1="8" x2="12" y2="13"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="2" x2="9" y2="5"/><line x1="15" y1="2" x2="15" y2="5"/><line x1="9" y1="19" x2="9" y2="22"/><line x1="15" y1="19" x2="15" y2="22"/><line x1="2" y1="9" x2="5" y2="9"/><line x1="2" y1="15" x2="5" y2="15"/><line x1="19" y1="9" x2="22" y2="9"/><line x1="19" y1="15" x2="22" y2="15"/>',
  print: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
};
function icon(name, cls) {
  return `<svg class="${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

const fmt = {
  int: (n) => (Number(n) || 0).toLocaleString("en-US"),
  compact: (n) => Charts.compact(n),
  signed: (n) => (n > 0 ? "+" : "") + fmt.int(n),
  pct: (n, digits) => (n == null || !isFinite(n) ? "–" : (n > 0 ? "+" : "") + Number(n).toFixed(digits || 0) + "%"),
  // Full figures up to a million so a column reads the same in every row; compact ("€1.2M") only above that.
  money(n, currency, compact) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    const big = compact && a >= 1e6;
    const digits = big ? 1 : a >= 100 ? 0 : 2;
    const opts = big ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: digits, minimumFractionDigits: digits };
    try {
      if (currency) return new Intl.NumberFormat("en-US", { style: "currency", currency, ...opts }).format(n);
    } catch (e) { /* unknown currency code: fall through */ }
    return n.toLocaleString("en-US", opts) + (currency ? " " + currency : "");
  },
  date: (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" }) : ""),
  dateShort: (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { month: "short", day: "numeric" }) : ""),
  dateTime: (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""),
  rel(iso) {
    if (!iso) return "";
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return "";
    const s = Math.round(ms / 1000);
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d} d ago`;
    return fmt.date(iso);
  },
  month(ym) {
    const [y, m] = String(ym || "").split("-");
    if (!y || !m) return String(ym || "");
    return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  },
  monthShort(ym) {
    const [y, m] = String(ym || "").split("-");
    if (!y || !m) return String(ym || "");
    const s = new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    return m === "01" ? `${s} ${y.slice(2)}` : s;
  },
  humanize: (s) => String(s || "").replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
};

/* ---------- static knowledge about the tools ---------- */
const TOOLS = [
  { id: "orphaned-resources", group: "resources", label: "Orphaned resources", icon: "trash", schedule: "Daily at 03:00", sub: "Leftovers that cost money or just clutter: disks, IPs, snapshots, VMs stopped but still billed, idle gateways, load balancers, endpoints, backups of deleted VMs and more, with what each costs a month at Azure's list price. Plus storage accounts with no lifecycle policy, workspaces with no daily cap (optional) and Azure Advisor's cost tips." },
  { id: "tag-compliance", group: "resources", label: "Tag compliance", icon: "tag", schedule: "Daily at 04:00", sub: "Resources that are missing the tags the organisation requires." },
  { id: "cost-anomaly", group: "cost", label: "Cost anomalies", icon: "trend", schedule: "Daily at 07:00", sub: "Resource groups whose cost yesterday jumped against the day before (by 50 % or more unless set otherwise in Settings)." },
  { id: "access-review", group: "access", label: "Access review", icon: "shield", schedule: "Weekly, Monday at 05:00", sub: "Long-standing Owner, Contributor and User Access Administrator assignments, direct and via groups, with the people behind each group." },
  { id: "secret-expiry", group: "access", label: "Expiring app credentials", icon: "key", schedule: "Daily at 06:00", sub: "App registration secrets and certificates that expire soon, apps with no owner, apps that use only client secrets, and secrets valid longer than the set maximum." },
  { id: "key-vault", group: "resources", label: "Key Vault", icon: "shield", schedule: "Daily at 05:45", sub: "Vault settings (soft delete, purge protection, open networks, access policies), secrets, keys and certificates that expired, expire soon or never expire, who can read secrets, and vaults with no logging, no owner or no use." },
  { id: "access-packages", group: "access", label: "Access packages", icon: "box", schedule: "Daily at 05:00", sub: "Entitlement management packages that expire soon, auto-approve without an end date, go unused or have weak approval: approver groups with no members, one approver only." },
  { id: "role-assignments", group: "access", label: "Role assignments", icon: "users", schedule: "Daily at 04:15", sub: "Assignments whose user, group or app was deleted (\"Identity not found\": safe to remove), Owner and access-granting roles given to a person directly on a whole subscription, Azure roles held by guests, custom roles that allow everything or can hand out access, and subscriptions close to Azure's limit of 4,000 role assignments." },
  { id: "policy-check", group: "governance", label: "Policy check", icon: "policy", schedule: "Daily at 05:30", sub: "Probes ask Azure whether risky resources (public storage, plain HTTP, public IPs, open SQL, untagged, blocked regions) would be allowed in each subscription; nothing is created. Health checks find policy assignments that cannot work." },
  { id: "internet-exposure", group: "resources", label: "Internet exposure", icon: "globe", schedule: "Daily at 03:30", sub: "Network security group rules open to the whole internet (admin and database ports, all ports), VMs with a public IP, storage containers anyone can read and database firewalls open to everyone or to all of Azure." },
  { id: "end-of-support", group: "resources", label: "End of support", icon: "clock", schedule: "Weekly, Monday at 06:00", sub: "AKS clusters on a Kubernetes version Azure no longer supports, App Service runtimes (Node.js, Python, .NET, PHP) and VM operating systems past or near end of support, and services that still accept TLS 1.0 or 1.1." },
  { id: "service-retirements", group: "resources", label: "Service retirements", icon: "calendar", schedule: "Daily at 06:15", sub: "Azure features and services being retired that your resources still use, from Azure Advisor, with the retirement date." },
  { id: "certificates", group: "resources", label: "Certificates", icon: "lock", schedule: "Daily at 06:20", sub: "TLS certificates of your websites: the custom domains of App Service apps found in Azure, plus any address listed in Settings. Flags certificates that expired or expire soon, are not for the site's name, or that browsers will not trust, and sites that do not answer." },
  { id: "defender", group: "resources", label: "Defender for Cloud", icon: "shield", schedule: "Daily at 06:40", sub: "Microsoft Defender for Cloud in short: subscriptions whose secure score is low, unhealthy recommendations with how many resources each hits, Defender plans that are off although they should be on, and plans that are on in some subscriptions but off in others." },
  { id: "safety-nets", group: "governance", label: "Safety nets", icon: "alert", schedule: "Daily at 06:50", sub: "Subscriptions with no cost budget, or a budget that alerts nobody, and key resources (key vaults, backup vaults, VNets, DNS zones) with no delete lock on them, their resource group or their subscription." },
  { id: "backup-coverage", group: "resources", label: "Backup coverage", icon: "archive", schedule: "Daily at 07:15", sub: "VMs without a backup, backups that stopped, failed or are too old, and Recovery Services vaults without soft delete or with backups in one datacenter only." },
  { id: "resilience", group: "resources", label: "Resilience", icon: "gauge", schedule: "Daily at 03:15", sub: "What one failure would take down: single VMs, AKS, App Service, gateways and databases not spread over zones or instances, storage in one datacenter, no Service Health alert. Each finding links to its PSRule for Azure rule." },
  { id: "resource-settings", group: "resources", label: "Resource settings", icon: "lock", schedule: "Daily at 03:45", sub: "Risky settings on common services: access keys and admin users still on, plain HTTP and FTP, open storage firewalls, AKS without Entra sign-in, remote debugging. Each finding links to its PSRule for Azure rule." },
  { id: "exposure-paths", group: "resources", label: "Exposure paths", icon: "network", schedule: "Daily at 04:30", sub: "Attack paths that only show when resources are looked at together: an internet-facing VM or web app whose identity can take over a subscription or read secrets, whose network reaches a database or key vault with no NSG or firewall in between, or from which an attacker can sign in to the next machine and the next. Also a subnet-to-subnet map of each VNet." },
  { id: "diagnostic-settings", group: "governance", label: "Diagnostic settings", icon: "activity", schedule: "Daily at 04:30", sub: "Resources whose logs go nowhere: no diagnostic setting, a setting that sends to a deleted workspace, storage account or event hub, or one that sends metrics but no logs. Also subscriptions whose activity log is not exported beyond Azure's 90 days, NSG flow logs (they stop in September 2027) and VNets with no flow log." },
  { id: "azure-monitor", group: "governance", label: "Azure Monitor", icon: "activity", schedule: "Daily at 04:55", sub: "Whether Azure Monitor watches everything and works: VMs and Arc servers with no agent, the retired legacy agent, no data collection rule or no heartbeat, alert rules that are off, alert nobody or watch a deleted resource, broken action groups and workspaces at their daily cap. Switch it off per tenant in Settings (Azure Monitor) for customers who do not use it." },
  { id: "vulnerabilities", group: "resources", label: "Vulnerabilities (CVEs)", icon: "shield", schedule: "Daily at 06:55", sub: "Known vulnerabilities (CVEs) that Defender for Cloud found on machines and container images, one row per CVE with the resources it is on. CVEs on CISA's known exploited list come first, then those likely to be exploited soon (EPSS), then critical ones. Also subscriptions with machines or registries that Defender does not scan." },
  { id: "updates", group: "resources", label: "Updates and patching", icon: "clock", schedule: "Daily at 06:25", sub: "From Azure Update Manager: running VMs and Arc servers with Critical or Security updates pending (critical when the oldest is older than the set number of days), machines not assessed lately or whose assessment failed, VMs on no patch schedule at all, and machines whose latest update installation failed or ended with warnings." },
  { id: "resource-health", group: "resources", label: "Resource health", icon: "activity", schedule: "Every hour", sub: "Resources Azure reports as Unavailable or Degraded right now, with why and since when (VMs you stopped yourself are left out), and Service Health events that hit your subscriptions: active outages, health and security advisories, and planned maintenance starting soon, each with its Service Health link." },
  { id: "avd", group: "resources", label: "Azure Virtual Desktop", icon: "app", schedule: "Daily at 06:35", sub: "Azure Virtual Desktop in short: session hosts that are Unavailable or need assistance (with the failed health checks), not ready, shut down with nothing to start them, whose agent update failed or that sit in drain mode with no heartbeat for a week; host pools with no session hosts, pooled pools with no scaling plan, personal desktops assigned to nobody, personal pools without Start VM on Connect; application groups no workspace shows and empty workspaces. Tenants with no host pools are skipped." },
  { id: "network-hygiene", group: "resources", label: "Network hygiene", icon: "network", schedule: "Daily at 05:05", sub: "Network settings that look fine but protect or route nothing: WAF policies in Detection mode or turned off (Application Gateway and Front Door), WAF gateways with no WAF at all, public Standard gateways with no WAF, DNS records that point at an Azure name nobody owns any more (subdomain takeover) or at a deleted resource, and routes to a virtual appliance address that belongs to nothing, so the traffic is dropped." },
  { id: "connectivity", group: "resources", label: "Connectivity health", icon: "network", schedule: "Every hour", sub: "Connections that are down right now: site-to-site and VNet-to-VNet VPN connections not connected, ExpressRoute circuits not provisioned or with private peering off, VPN and ExpressRoute gateways in a failed state, private endpoints waiting for approval or with no private DNS zone group, and Application Gateways, Standard load balancers and Front Door profiles whose backends failed their health probes in the last hour." },
  { id: "domains", group: "resources", label: "Domains and mail", icon: "globe", schedule: "Daily at 07:25 (off until turned on in Settings)", sub: "The organisation's own domains (from user names and mail addresses, App Service custom domains, Azure DNS zones and App Service Domains): registrations that expire soon or have no transfer lock, App Service Domains without auto-renew, Azure DNS zones the internet does not delegate to, and for domains that receive mail a missing or weak SPF record, SPF over 10 lookups, a missing DMARC record or p=none, and missing Exchange Online DKIM records." },
  { id: "subscriptions", group: "governance", label: "Subscriptions", icon: "box", schedule: "Daily at 04:35", sub: "Subscriptions sitting directly in the Tenant Root Group (management group policies and access do not reach them), with no Owner on the subscription or a management group above it, or not enabled: Warned or PastDue (about to be switched off) and Disabled ones left behind." },
  { id: "quotas", group: "governance", label: "Quotas", icon: "gauge", schedule: "Daily at 04:45", sub: "Compute, network and storage quotas close to their limit in the regions each subscription uses, before a deployment or scale-out fails on them." },
  { id: "ipam", group: "resources", label: "IP addresses", icon: "network", schedule: "Daily at 04:20", sub: "What goes wrong with addresses: overlapping ranges, subnets running out, public or off-plan address space, broken peerings and untidy firewall IP groups. Free addresses are on the IPAM page." },
  { id: "firewall-policies", group: "resources", label: "Firewall policies", icon: "wall", schedule: "Daily at 04:50", sub: "Every Azure Firewall policy with its rules laid out in the order the firewall checks them, and what is wrong in them: duplicate rules, rules that never apply because an earlier rule already allows or blocks the traffic, rules covered by a wider one, any-to-any and all-port allows, admin ports forwarded from the internet, missing IP groups, threat intelligence or IDPS off. Classic firewall rules are read too. The Reach map shows every rule that lets traffic in to or out from a picked VM or IP address." },
  { id: "architecture", group: "resources", info: true, drawing: true, label: "Architecture", icon: "grid", schedule: "Daily at 04:40", sub: "A drawing of the environment. Pick resource groups or whole subscriptions; the virtual networks and subnets their resources sit in are found and drawn by themselves, with peerings, VPN and ExpressRoute sites, private endpoints and public IPs. Download it as SVG, PNG or a draw.io file to edit. For information: no findings." },
  { id: "change-log", group: "governance", info: true, label: "Change log", icon: "history", schedule: "Daily at 08:00", sub: "What people and apps created, changed or deleted in the last 24 hours, with network, public access, TLS and permission changes marked. For information: not counted as open findings." },
  { id: "privileged-roles", group: "identity", label: "Privileged roles", icon: "crown", schedule: "Daily at 05:00", sub: "Who holds the powerful Entra roles: too many or too few Global Administrators, guests, apps and disabled accounts in admin roles, permanent admin rights where PIM is in use, admins with no MFA registered, and fewer than two working emergency access (break-glass) accounts." },
  { id: "pim", group: "identity", label: "PIM", icon: "crown", schedule: "Daily at 05:10", sub: "A PIM review for Entra and Azure roles. PIM access lists everyone who can activate a role, directly or through a group (a group that is eligible for a role, or PIM for Groups membership of a group that holds one); Groups lists those groups. Findings: activation without MFA, a reason or approval, activation that lasts too long, roles that may be given permanently, guests and disabled accounts with PIM access, access that never ends, runs out soon or is never used, groups that are not role-assignable or have permanent members, and permanent Owners next to people who must activate. Needs Microsoft Entra ID P2." },
  { id: "stale-accounts", group: "identity", label: "Stale accounts", icon: "userx", schedule: "Daily at 05:30", sub: "Enabled members and guests with no sign-in for a long time, accounts that never signed in and guest invitations never accepted. Sign-in data needs Microsoft Entra ID P1." },
  { id: "mfa-coverage", group: "identity", label: "MFA coverage", icon: "user", schedule: "Daily at 05:50", sub: "Enabled member accounts with no MFA method registered, and accounts that can only use a phone call or text message. Admins are covered by Privileged roles, guests by their own organisation. Needs Microsoft Entra ID P1." },
  { id: "conditional-access", group: "identity", label: "Conditional Access", icon: "lock", schedule: "Daily at 05:45", sub: "Gaps in Conditional Access: no MFA for all users or for admins, legacy sign-in not blocked, policies left in report-only and policies with long exclusion lists." },
  { id: "app-permissions", group: "identity", label: "App permissions", icon: "grid", schedule: "Daily at 05:15", sub: "Apps with Microsoft Graph permissions that could take over the tenant or read everyone's data, risky delegated consents, and whether users may consent to any app themselves." },
  { id: "enterprise-apps", group: "identity", label: "Enterprise apps", icon: "grid", schedule: "Daily at 05:20", sub: "Enterprise apps (service principals): SAML signing certificates that expired or expire soon, secrets and certificates set on the service principal itself, single sign-on apps anyone in the tenant may sign in to, apps from this tenant with no owner, other companies' apps not used for 90 days and disabled apps that still hold Azure roles. Microsoft's own apps and managed identities are left out." },
  { id: "tenant-settings", group: "identity", label: "Entra tenant settings", icon: "shield", schedule: "Daily at 05:25", sub: "Tenant settings that let any user register apps, create tenants or groups, invite guests or join by email sign-up; guests with member access; B2B direct connect open to all tenants." },
  { id: "licence-coverage", group: "identity", label: "Licence coverage", icon: "badge", schedule: "Daily at 06:00", sub: "How many Entra ID P1, P2 and ID Governance licences the features in use need, against how many the tenant owns. Counts the people in scope of Conditional Access, with PIM eligible or time-bound roles (Entra roles, Azure roles, PIM for Groups) and with access packages. Guests are billed per monthly active user and shown apart." },
];
const TOOL_GROUPS = [
  { id: "access", label: "Access" },
  { id: "identity", label: "Identity" },
  { id: "resources", label: "Resources" },
  { id: "governance", label: "Governance" },
  { id: "cost", label: "Cost" },
];
const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

// kind -> [label, severity]; anything unknown is humanised and neutral
const KINDS = {
  "unattached-disk": ["Unattached disk", "warn"],
  "orphaned-nic": ["Orphaned NIC", "warn"],
  "unused-public-ip": ["Unused public IP", "warn"],
  "empty-resource-group": ["Empty resource group", ""],
  "orphaned-snapshot": ["Snapshot of deleted disk", "warn"],
  "empty-app-service-plan": ["App Service plan, no apps", "warn"],
  "old-snapshot": ["Old snapshot", "info"],
  "stopped-vm": ["VM stopped, still billed", "warn"],
  "idle-nat-gateway": ["NAT gateway, no subnet", "warn"],
  "empty-load-balancer": ["Load balancer, empty pools", "warn"],
  "idle-app-gateway": ["App gateway, empty pools", "warn"],
  "idle-vnet-gateway": ["VPN/ER gateway, no connections", "warn"],
  "disconnected-private-endpoint": ["Private endpoint, disconnected", "warn"],
  "unlinked-private-dns-zone": ["Private DNS zone, no links", "info"],
  "unused-nsg": ["NSG, attached to nothing", "info"],
  "unused-route-table": ["Route table, attached to nothing", "info"],
  "empty-availability-set": ["Availability set, no VMs", "info"],
  "empty-elastic-pool": ["SQL elastic pool, no databases", "warn"],
  "advisor-cost": ["Azure Advisor cost tip", "info"],
  "backup-vm-deleted": ["Backup of a deleted VM", "warn"],
  "rel-vm-standalone": ["Single VM, no zone or availability set", "warn"],
  "rel-aks-zones": ["AKS node pools not in zones", "warn"],
  "rel-aks-min-nodes": ["AKS system pool under 3 nodes", "warn"],
  "rel-aks-free-tier": ["AKS free tier (no SLA)", "warn"],
  "rel-plan-one-instance": ["App Service plan on 1 instance", "warn"],
  "rel-plan-no-zones": ["App Service plan not zone redundant", "warn"],
  "rel-storage-lrs": ["Storage kept in one datacenter", "warn"],
  "rel-pip-one-zone": ["Public IP in one zone", "warn"],
  "rel-lb-zones": ["Load balancer not zone redundant", "warn"],
  "rel-agw-zones": ["App gateway not zone redundant", "warn"],
  "rel-agw-one-instance": ["App gateway on 1 instance", "warn"],
  "rel-vpn-legacy-sku": ["Legacy VPN gateway SKU", "crit"],
  "rel-vpn-no-zones": ["VPN gateway not zone redundant", "warn"],
  "rel-vpn-not-active-active": ["VPN gateway not active-active", "warn"],
  "rel-er-legacy-sku": ["Legacy ExpressRoute gateway SKU", "crit"],
  "rel-er-no-zones": ["ExpressRoute gateway not zone redundant", "warn"],
  "rel-no-service-health": ["No Service Health alert", "warn"],
  "rel-pg-no-geo-backup": ["PostgreSQL without geo-backup", "warn"],
  "rel-pg-no-zone-ha": ["PostgreSQL without zone HA", "warn"],
  "rel-mysql-no-geo-backup": ["MySQL without geo-backup", "warn"],
  "rel-mysql-no-zone-ha": ["MySQL without zone HA", "warn"],
  "cfg-storage-http": ["Storage accepts HTTP", "warn"],
  "cfg-storage-no-firewall": ["Storage open to all networks", "warn"],
  "cfg-storage-keys": ["Storage access keys on", "warn"],
  "cfg-sql-no-entra-admin": ["SQL server without Entra admin", "crit"],
  "cfg-sql-sql-logins": ["SQL logins still allowed", "warn"],
  "cfg-app-http": ["Web app answers on HTTP", "warn"],
  "cfg-app-remote-debug": ["Remote debugging on", "warn"],
  "cfg-app-ftp": ["Plain FTP allowed", "warn"],
  "cfg-acr-admin": ["Registry admin user on", "crit"],
  "cfg-acr-anonymous": ["Registry anonymous pull", "warn"],
  "cfg-aks-local-accounts": ["AKS local accounts on", "warn"],
  "cfg-aks-no-entra": ["AKS without Entra sign-in", "warn"],
  "cfg-aks-k8s-rbac": ["AKS not using Azure RBAC", "warn"],
  "cfg-aks-open-api": ["AKS API open to any IP", "warn"],
  "cfg-aks-no-auto-upgrade": ["AKS without auto-upgrade", "warn"],
  "cfg-redis-plain-port": ["Redis non-TLS port open", "crit"],
  "cfg-cosmos-keys": ["Cosmos DB keys on", "crit"],
  "cfg-cosmos-metadata": ["Cosmos DB keys can change metadata", "warn"],
  "cfg-servicebus-keys": ["Service Bus keys on", "warn"],
  "cfg-eventhub-keys": ["Event Hubs keys on", "warn"],
  "cfg-appconfig-keys": ["App Configuration keys on", "warn"],
  "path-identity-takeover": ["Internet entry with takeover rights", "crit"],
  "path-identity-data": ["Internet entry can read sensitive data", "warn"],
  "path-lateral-admin": ["Open admin port next to sensitive data", "crit"],
  "path-lateral-data": ["Internet entry reaches sensitive data", "warn"],
  "path-pivot-takeover": ["Hop to a machine with takeover rights", "crit"],
  "path-pivot-data": ["Hop to sensitive data", "warn"],
  "seg-flat-vnet": ["Flat VNet", "warn"],
  "seg-vnet-map": ["Subnet map", "info"],
  "missing-tags": ["Missing tags", "warn"],
  "cost-jump": ["Cost jump", "crit"],
  "scan-error": ["Scan error", "warn"],
  "stale-direct-assignment": ["Direct assignment", "warn"],
  "stale-group-assignment": ["Group assignment", ""],
  "app-credential-expiring": ["App credential expiring", "warn"],
  "keyvault-cert-expiring": ["Key Vault cert expiring", "warn"],
  "kv-soft-delete-off": ["Soft delete off", "crit"],
  "kv-purge-protection-off": ["Purge protection off", "warn"],
  "kv-public-network": ["Open to all networks", "warn"],
  "kv-access-policies": ["Access policy model", ""],
  "kv-expired": ["Expired", "crit"],
  "kv-expiring": ["Expiring", "warn"],
  "kv-no-expiry": ["No expiry date", ""],
  "kv-no-data-access": ["Items not checked", ""],
  "kv-broad-secret-access": ["Broad secret access", "crit"],
  "kv-many-readers": ["Many secret readers", "warn"],
  "kv-guest-access": ["Guest can read secrets", "warn"],
  "kv-deleted-principal": ["Policy for deleted identity", "warn"],
  "kv-no-diagnostics": ["No audit log", "warn"],
  "kv-no-owner-tag": ["No owner tag", ""],
  "kv-empty": ["Empty vault", ""],
  "kv-unused": ["Unused vault", ""],
  "access-package-expiring": ["Package expiring", "warn"],
  "access-package-auto-approved-no-expiry": ["Auto-approved, no expiry", "crit"],
  "access-package-duplicate-name": ["Duplicate name", ""],
  "access-package-pending-too-long": ["Request pending too long", "warn"],
  "access-package-single-approver": ["Single approver", "warn"],
  "access-package-no-approver": ["Nobody can approve", "crit"],
  "access-package-empty-approver-group": ["Empty approver group", "warn"],
  "access-package-unused": ["Unused package", ""],
  "orphaned-assignment": ["Identity not found", "warn"],
  "assignment-limit": ["Near assignment limit", "crit"],
  "privileged-direct-user": ["Admin role to a person", "warn"],
  "guest-azure-admin": ["Guest with admin role", "crit"],
  "guest-azure-role": ["Guest with Azure role", "warn"],
  "custom-role-broad": ["Broad custom role", "warn"],
  "probe-not-blocked": ["Not blocked", "crit"],
  "probe-only-audited": ["Only audited", "warn"],
  "enforcement-off": ["Enforcement off", "crit"],
  "effect-disabled": ["Effect disabled", "warn"],
  "definition-missing": ["Definition missing", "crit"],
  "identity-missing": ["Identity missing", "crit"],
  "identity-lacks-roles": ["Identity lacks roles", "crit"],
  "remediation-failed": ["Remediation failed", "crit"],
  "remediation-not-run": ["Remediation never run", "warn"],
  "evaluates-nothing": ["Evaluates nothing", "warn"],
  "exemption-no-expiry": ["Exemption without end date", "warn"],
  "exemption-expired": ["Exemption expired", "warn"],
  "exemption-expiring": ["Exemption expiring", ""],
  "nsg-open-admin-port": ["Admin port open", "crit"],
  "nsg-open-db-port": ["Database port open", "crit"],
  "nsg-open-all-ports": ["All ports open", "crit"],
  "nsg-open-unattached": ["Open rule, NSG unused", ""],
  "vm-public-ip": ["VM with public IP", "warn"],
  "storage-public-container": ["Public container", "crit"],
  "storage-public-allowed": ["Anonymous access allowed", ""],
  "db-firewall-open-all": ["Firewall open to all", "crit"],
  "db-firewall-azure-services": ["Open to all of Azure", "warn"],
  "db-firewall-wide-range": ["Wide firewall range", "warn"],
  "aks-unsupported": ["Kubernetes unsupported", "crit"],
  "aks-oldest-supported": ["Oldest Kubernetes", "warn"],
  "runtime-end-of-support": ["Runtime out of support", "crit"],
  "runtime-support-ending": ["Runtime support ending", "warn"],
  "os-end-of-support": ["OS out of support", "crit"],
  "os-support-ending": ["OS support ending", "warn"],
  "tls-old-allowed": ["Old TLS allowed", "warn"],
  "retirement-past": ["Retired", "crit"],
  "retirement-soon": ["Retiring soon", "warn"],
  "retirement-planned": ["Retirement planned", ""],
  "cert-expired": ["Certificate expired", "crit"],
  "cert-expiring": ["Certificate expiring", "warn"],
  "cert-name-mismatch": ["Wrong name on certificate", "crit"],
  "cert-untrusted": ["Untrusted certificate", "crit"],
  "cert-unreachable": ["Site not reachable", "warn"],
  "vm-no-backup": ["No backup", "warn"],
  "backup-stopped": ["Backup stopped", "warn"],
  "backup-failing": ["Backup failing", "crit"],
  "backup-stale": ["Backup too old", "crit"],
  "vault-soft-delete-off": ["Vault soft delete off", "crit"],
  "vault-lrs": ["Locally redundant vault", ""],
  "no-diagnostic-setting": ["No diagnostic setting", "warn"],
  "activity-log-not-exported": ["Activity log not exported", "warn"],
  "diagnostic-destination-missing": ["Logs sent to deleted target", "crit"],
  "diagnostic-no-logs": ["Metrics only, no logs", "warn"],
  "nsg-flow-log": ["NSG flow log (retiring)", "warn"],
  "flow-log-storage-missing": ["Flow log to deleted storage", "crit"],
  "vnet-no-flow-log": ["No flow log", ""],
  "monitor-no-agent": ["No monitoring agent", "warn"],
  "monitor-legacy-agent": ["Legacy agent only", "crit"],
  "monitor-agent-failed": ["Agent failed", "crit"],
  "monitor-no-dcr": ["No collection rule", "warn"],
  "monitor-no-heartbeat": ["No heartbeat", "crit"],
  "monitor-arc-disconnected": ["Arc disconnected", "warn"],
  "dcr-destination-missing": ["Rule sends nowhere", "crit"],
  "dcr-unused": ["Rule not linked", ""],
  "alert-disabled": ["Alert rule off", ""],
  "alert-no-action": ["Alert tells nobody", "warn"],
  "alert-action-group-missing": ["Action group deleted", "crit"],
  "alert-scope-missing": ["Watches deleted resource", "warn"],
  "action-group-disabled": ["Action group off", "crit"],
  "action-group-empty": ["Action group empty", "crit"],
  "action-group-email-off": ["Email unsubscribed", "warn"],
  "workspace-over-quota": ["Daily cap reached", "crit"],
  "workspace-near-quota": ["Near daily cap", "warn"],
  "quota-near-limit": ["Quota near limit", "warn"],
  "quota-at-limit": ["Quota at limit", "crit"],
  "security-change": ["Security change", "warn"],
  "resource-created": ["Created", ""],
  "resource-updated": ["Changed", ""],
  "resource-deleted": ["Deleted", ""],
  "too-many-global-admins": ["Too many Global Admins", "warn"],
  "too-few-global-admins": ["Too few Global Admins", "warn"],
  "privileged-guest": ["Guest admin", "crit"],
  "privileged-app": ["App with admin role", "warn"],
  "privileged-group": ["Group with admin role", ""],
  "privileged-disabled": ["Disabled admin", "warn"],
  "privileged-standing": ["Permanent admin", "warn"],
  "privileged-no-mfa": ["Admin without MFA", "crit"],
  "break-glass-too-few": ["Too few emergency accounts", "crit"],
  "break-glass-weak": ["Emergency account at risk", "warn"],
  "break-glass-not-admin": ["Emergency account not admin", "crit"],
  "pim-activation-no-mfa": ["PIM: no MFA to activate", "crit"],
  "pim-activation-no-reason": ["PIM: no reason asked", "warn"],
  "pim-activation-no-approval": ["PIM: no approval", "warn"],
  "pim-activation-too-long": ["PIM: long activation", "warn"],
  "pim-permanent-active-allowed": ["PIM: permanent allowed", "warn"],
  "pim-permanent-eligible-allowed": ["PIM: endless eligibility allowed", ""],
  "pim-eligible-guest": ["PIM: eligible guest", "crit"],
  "pim-eligible-disabled": ["PIM: eligible disabled account", "warn"],
  "pim-eligible-no-end": ["PIM: eligible with no end", ""],
  "pim-eligible-expiring": ["PIM: eligibility ending", "warn"],
  "pim-eligible-unused": ["PIM: eligibility unused", "warn"],
  "pim-azure-standing": ["PIM: permanent Azure owner", "warn"],
  "pim-group-not-role-assignable": ["PIM group not role-assignable", "warn"],
  "pim-group-permanent-member": ["PIM group: permanent members", "warn"],
  "stale-user": ["Stale account", "warn"],
  "stale-guest": ["Stale guest", "warn"],
  "never-signed-in": ["Never signed in", "warn"],
  "guest-invite-pending": ["Invite not accepted", ""],
  "user-no-mfa": ["No MFA registered", "warn"],
  "mfa-weak-only": ["Phone or SMS only", ""],
  "ca-none": ["No Conditional Access", "crit"],
  "ca-no-mfa-all-users": ["No MFA for all users", "crit"],
  "ca-no-admin-mfa": ["No MFA for admins", "crit"],
  "ca-legacy-auth-not-blocked": ["Legacy sign-in allowed", "warn"],
  "ca-report-only": ["Report-only policy", ""],
  "ca-many-exclusions": ["Many exclusions", "warn"],
  "security-defaults-only": ["Security defaults", ""],
  "app-takeover-permission": ["Tenant takeover permission", "crit"],
  "app-broad-data-permission": ["Broad data permission", "warn"],
  "app-risky-delegated-consent": ["Risky consent", "warn"],
  "ent-saml-cert-expired": ["SAML certificate expired", "crit"],
  "ent-saml-cert-expiring-soon": ["SAML certificate expires within 14 days", "crit"],
  "ent-saml-cert-expiring": ["SAML certificate expiring", "warn"],
  "ent-sp-credential-expired": ["Service principal credential expired", "crit"],
  "ent-sp-credential-expiring-soon": ["Service principal credential expires within 14 days", "crit"],
  "ent-sp-credential-expiring": ["Service principal credential expiring", "warn"],
  "ent-sp-secret": ["Secret on the service principal", ""],
  "ent-open-sign-in": ["Anyone in the tenant can sign in", ""],
  "ent-no-owner": ["Enterprise app without owner", ""],
  "ent-unused-app": ["Third-party app not used", ""],
  "ent-disabled-azure-roles": ["Disabled app holds Azure roles", "warn"],
  "user-consent-unrestricted": ["Users can consent", "warn"],
  "licence-short": ["Not enough licences", "crit"],
  "licence-count": ["Licences needed", ""],
  "licence-user": ["Needs a licence", ""],
  "subnet-full": ["Subnet full", "crit"],
  "subnet-near-full": ["Subnet filling up", "warn"],
  "ip-overlap": ["Overlapping range", "warn"],
  "ip-overlap-onprem": ["Overlaps on-premises", "crit"],
  "ip-public-space": ["Public address space", "warn"],
  "ip-outside-plan": ["Outside address plan", "warn"],
  "vnet-no-room": ["No room for subnets", ""],
  "peering-disconnected": ["Peering disconnected", "crit"],
  "peering-not-synced": ["Peering not synced", "warn"],
  "ipgroup-failed": ["IP group failed", "crit"],
  "ipgroup-empty": ["Empty IP group", "warn"],
  "ipgroup-unused": ["Unused IP group", ""],
  "ipgroup-near-limit": ["IP group near limit", "warn"],
  "ipgroup-redundant": ["Covered entries", ""],
  "ipgroup-wide": ["Very wide entry", "warn"],
  "ipgroup-duplicate": ["Duplicate IP group", ""],
  "fw-shadowed-deny": ["Deny never applies", "crit"],
  "fw-shadowed-allow": ["Allow never applies", "warn"],
  "fw-duplicate": ["Duplicate rule", "warn"],
  "fw-redundant": ["Covered by another rule", ""],
  "fw-any-any": ["Any-to-any allow", "crit"],
  "fw-any-port": ["All ports allowed", "warn"],
  "fw-app-any-fqdn": ["Every FQDN allowed", "warn"],
  "fw-dnat-open-admin": ["Admin port open to internet", "crit"],
  "fw-ipgroup-missing": ["Missing IP group or parent", "warn"],
  "fw-fqdn-no-dns-proxy": ["FQDN rules without DNS proxy", "warn"],
  "fw-policy-failed": ["Policy failed", "crit"],
  "fw-policy-unused": ["Unused policy", ""],
  "fw-empty": ["Policy without rules", ""],
  "fw-threat-intel-off": ["Threat intelligence off", "warn"],
  "fw-idps-off": ["IDPS off on Premium", ""],
  "fw-classic-rules": ["Classic firewall rules", ""],
  "fw-not-compared": ["Rules not compared", ""],
  "defender-low-score": ["Low secure score", "warn"],
  "defender-high": ["High severity", "crit"],
  "defender-medium": ["Medium severity", "warn"],
  "defender-low": ["Low severity", ""],
  "defender-plan-off": ["Plan off", "warn"],
  "defender-plan-uneven": ["Plan off here, on elsewhere", "warn"],
  "no-budget": ["No budget", "warn"],
  "budget-no-alerts": ["Budget alerts nobody", "warn"],
  "no-delete-lock": ["No delete lock", "warn"],
  "storage-no-lifecycle": ["Storage, no lifecycle policy", "info"],
  "workspace-no-cap": ["Workspace, no daily cap", "info"],
  "tenant-users-create-apps": ["Users can register apps", "warn"],
  "tenant-users-create-tenants": ["Users can create tenants", "warn"],
  "tenant-users-create-groups": ["Users can create groups", ""],
  "tenant-guest-invite-open": ["Anyone can invite guests", "warn"],
  "tenant-guest-invite-members": ["Members can invite guests", ""],
  "tenant-guest-access-member": ["Guests have member access", "warn"],
  "tenant-email-signup": ["Email sign-up can join", "warn"],
  "tenant-direct-connect-open": ["Direct connect open to all", "warn"],
  "app-no-owner": ["App without owner", "warn"],
  "app-secret-only": ["Secret only, no certificate", ""],
  "app-secret-long-lived": ["Long-lived secret", "warn"],
  "updates-pending-overdue": ["Overdue security updates", "crit"],
  "updates-pending-critical": ["Critical updates pending", "warn"],
  "updates-pending-security": ["Security updates pending", "warn"],
  "updates-not-assessed": ["Not assessed", "warn"],
  "updates-no-schedule": ["No patch schedule", ""],
  "updates-install-failed": ["Update install failed", "warn"],
  "cve-known-exploited": ["Known exploited CVE", "crit"],
  "cve-likely-exploited": ["Likely exploited soon (EPSS)", "crit"],
  "cve-critical": ["Critical CVE", "warn"],
  "cve-high": ["High CVE", "warn"],
  "cve-medium": ["Medium CVE", ""],
  "cve-low": ["Low CVE", ""],
  "cve-no-data": ["Not scanned for CVEs", "warn"],
  "cve-feed-note": ["Ranking data missing", ""],
  "health-unavailable": ["Resource unavailable", "crit"],
  "health-degraded": ["Resource degraded", "warn"],
  "service-issue": ["Azure outage", "crit"],
  "service-advisory": ["Service advisory", "warn"],
  "service-maintenance": ["Planned maintenance", ""],
  "sub-in-root-mg": ["In tenant root group", "warn"],
  "sub-no-owner": ["No Owner", "warn"],
  "sub-state": ["Subscription warned or past due", "crit"],
  "sub-disabled": ["Subscription disabled", ""],
  "waf-detection": ["WAF in Detection mode", "warn"],
  "waf-disabled": ["WAF turned off", "warn"],
  "agw-no-waf": ["Public gateway without WAF", ""],
  "dns-dangling-cname": ["Dangling DNS (takeover risk)", "crit"],
  "dns-alias-missing": ["DNS alias to deleted resource", "crit"],
  "route-next-hop-missing": ["Route to missing appliance", "crit"],
  "conn-vpn-down": ["VPN connection down", "crit"],
  "conn-er-circuit-down": ["ExpressRoute circuit down", "crit"],
  "conn-er-peering-disabled": ["ExpressRoute private peering off", "crit"],
  "conn-gateway-failed": ["Gateway in failed state", "crit"],
  "conn-pe-pending": ["Private endpoint awaiting approval", "warn"],
  "conn-pe-no-dns": ["Private endpoint, no DNS zone group", "info"],
  "conn-agw-unhealthy": ["App gateway backends unhealthy", "warn"],
  "conn-lb-unhealthy": ["Load balancer backends unhealthy", "warn"],
  "conn-fd-unhealthy": ["Front Door origins unhealthy", "warn"],
  "avd-host-unavailable": ["Session host down", "crit"],
  "avd-host-not-ready": ["Session host not ready", "warn"],
  "avd-host-shutdown": ["Session host shut down", "warn"],
  "avd-agent-update-failed": ["AVD agent update failed", "warn"],
  "avd-host-drain-forgotten": ["Left in drain mode", ""],
  "avd-pool-empty": ["Host pool, no session hosts", ""],
  "avd-pool-no-scaling": ["Pooled host pool, no scaling plan", "warn"],
  "avd-personal-unassigned": ["Personal desktops unassigned", ""],
  "avd-no-start-on-connect": ["Start VM on Connect off", "info"],
  "avd-appgroup-no-workspace": ["App group in no workspace", "warn"],
  "avd-workspace-empty": ["Workspace, no app groups", ""],
  "domain-expired": ["Domain registration expired", "crit"],
  "domain-expiring": ["Domain expires within 30 days", "crit"],
  "domain-renewal-due": ["Domain expires within 60 days", "warn"],
  "domain-unlocked": ["Registrar lock off", ""],
  "asd-auto-renew-off": ["App Service Domain auto-renew off", "warn"],
  "dns-zone-not-delegated": ["DNS zone not delegated", "warn"],
  "spf-missing": ["No SPF record", "crit"],
  "spf-multiple": ["More than one SPF record", "crit"],
  "spf-pass-all": ["SPF allows everyone (+all)", "crit"],
  "spf-neutral-all": ["SPF neutral (?all)", "warn"],
  "spf-too-many-lookups": ["SPF over 10 DNS lookups", "warn"],
  "dmarc-missing": ["No DMARC record", "warn"],
  "dmarc-none": ["DMARC p=none", ""],
  "dkim-missing": ["DKIM records missing", ""],
};
const kindLabel = (k) => (KINDS[k] ? KINDS[k][0] : fmt.humanize(k));
const kindSev = (k) => (KINDS[k] ? KINDS[k][1] : "");
const kindBadge = (k) => `<span class="kind${kindSev(k) ? " k-" + kindSev(k) : ""}">${esc(kindLabel(k))}</span>`;

const PROBE_ORDER = ["storage-public-blob", "storage-http", "storage-old-tls", "public-ip", "keyvault-no-purge-protection", "sql-public-network", "untagged-resource", "denied-region"];
const PROBE_SHORT = {
  "storage-public-blob": "Public blob",
  "storage-http": "Plain HTTP",
  "storage-old-tls": "TLS 1.0",
  "public-ip": "Public IP",
  "keyvault-no-purge-protection": "KV purge off",
  "sql-public-network": "SQL public",
  "untagged-resource": "Untagged",
  "denied-region": "Denied region",
};
const LOG_TOOLS = {
  "access-lookup": "Access lookup",
  "cost-history": "Cost history",
  "server-load": "Server load",
  notifications: "Notifications",
};

/* ---------- state and API ---------- */
const state = { me: null, tools: {}, logs: [], logsAt: null, route: null, tenant: "" };

/* ---------- tenants ---------- */
// "" = every tenant the person may see; otherwise one tenant key. Kept per
// browser so the page opens on the same tab.
const TENANT_PREF = "dashboard.tenant";
const tenantList = () => (state.me && Array.isArray(state.me.tenants) ? state.me.tenants : []);
const showTenants = () => tenantList().length > 1;
// Rows name their tenant when the page shows more than one.
const multiView = () => showTenants() && !state.tenant;
// The tenants the page shows: the open tab, or all of them.
const shownTenants = () => (state.tenant ? tenantList().filter((t) => t.key === state.tenant) : tenantList());
// Areas of a scan or page, from /api/tools. The server decides what is sent; this only hides what would be empty.
const AREAS_ALL = ["identity", "platform", "security", "cost"];
const PAGE_AREAS = { "access-lookup": ["identity"], "cost-history": ["cost", "platform"] };
const areaLabel = (a) => ((state.me && state.me.areaLabels) || {})[a] || a;
const toolAreas = (id) => (TOOL_BY_ID[id] && TOOL_BY_ID[id].areas) || PAGE_AREAS[id] || null;
// Whether a tenant entry's area list (areas or runAreas from /api/me) covers a scan or page.
function reaches(list, id) {
  const want = toolAreas(id);
  const have = Array.isArray(list) ? list : AREAS_ALL;
  return want && want.length ? want.some((a) => have.includes(a)) : AREAS_ALL.every((a) => have.includes(a));
}
// Whether the person may see a scan or page in some tenant the page shows.
const mayRead = (id) => shownTenants().some((t) => reaches(t.areas, id));
// Run now rights: for a scan or page when id is given, else for anything.
function canRun(id) {
  const me = state.me || {};
  if (!id && !state.tenant) return Boolean(me.canRun);
  return shownTenants().some((t) => (id ? reaches(t.runAreas, id) : t.canRun));
}
// Accepting or snoozing a finding: anyone who sees its tenant (the server checks the scan's area).
function canRunFor(f) {
  return tenantList().some((x) => (f.tenant ? x.key === f.tenant : x.home));
}
// A scan is hidden when it is off (Settings, Scans) or outside the person's areas in every tenant the page shows.
function toolOff(id) {
  const list = shownTenants();
  return list.length > 0 && list.every((t) => (Array.isArray(t.scansOff) && t.scansOff.includes(id)) || !reaches(t.areas, id));
}
const shownTools = () => TOOLS.filter((t) => !toolOff(t.id));
// After scans were turned on or off: a new menu that keeps the current page and the counts.
function rebuildNav() {
  buildNav();
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.route === state.route));
  for (const t of shownTools()) {
    const ts = toolState(t.id);
    if (ts.loaded && ts.data && Array.isArray(ts.data.findings)) setNavCount(t.id, ts.data.findings.length);
  }
}
function initTenant() {
  let saved = "";
  try {
    saved = localStorage.getItem(TENANT_PREF) || "";
  } catch {
    /* storage blocked */
  }
  state.tenant = showTenants() && tenantList().some((t) => t.key === saved) ? saved : "";
}
function renderTenantTabs() {
  const bar = $("#tenant-tabs");
  if (!bar) return;
  bar.classList.toggle("hidden", !showTenants());
  if (!showTenants()) return;
  const tabs = [{ key: "", name: "All tenants" }, ...tenantList()];
  bar.innerHTML = tabs
    .map((t) => `<button class="tenant-tab${state.tenant === t.key ? " active" : ""}${t.enabled === false ? " off" : ""}" data-tenant="${esc(t.key)}" role="tab" aria-selected="${state.tenant === t.key}"${t.enabled === false ? ' title="Not scanned (turned off)"' : ""}>${esc(t.name)}</button>`)
    .join("");
}
function setTenant(key) {
  if (key === state.tenant) return;
  state.tenant = key;
  try {
    localStorage.setItem(TENANT_PREF, key);
  } catch {
    /* storage blocked */
  }
  // Everything shown so far was for the other tab.
  state.tools = {};
  state.logs = [];
  state.logsAt = null;
  Cost.reset();
  Report.reset();
  Ipam.reset();
  delete $("#page-scan").dataset.tool;
  renderTenantTabs();
  renderMe();
  buildNav();
  render();
  for (const t of shownTools()) if (!toolState(t.id).loaded) loadTool(t.id);
}
// The tenant tab goes on every data request (the server also limits it to
// what the person may see).
const TENANTLESS = /^\/api\/(me|settings|tenants|storage)(\/|\?|$)/;
function withTenant(path) {
  // A path that names its own tenant (Settings, notifications) keeps it.
  if (!state.tenant || !path.startsWith("/api/") || TENANTLESS.test(path) || /[?&]tenant=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}tenant=${encodeURIComponent(state.tenant)}`;
}

function toolState(id) {
  if (!state.tools[id]) {
    state.tools[id] = {
      id, loaded: false, loading: null, data: { ranAt: null, findings: [] }, history: [], snapshots: {}, selectedRun: null,
      accepted: [],
      filters: { q: "", kind: "", source: "", sub: "", newOnly: false, role: "", ptype: "", view: "probes", accepted: false, framework: "" },
      shown: 150, open: new Set(), running: false, runError: null, runStarted: null, runFinished: null, error: null,
    };
  }
  return state.tools[id];
}

async function api(path, opts) {
  const res = await fetch(withTenant(path), opts);
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("sign in required");
  }
  return res;
}
async function apiJson(path, opts) {
  const res = await api(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || (res.status === 403 ? "Admin role required" : `HTTP ${res.status}`));
    err.status = res.status;
    throw err;
  }
  return body;
}
const postJson = (path, body) => apiJson(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

function loadTool(id) {
  const t = toolState(id);
  if (t.loading) return t.loading;
  t.loading = (async () => {
    try {
      const [data, history] = await Promise.all([apiJson(`/api/tools/${id}/findings`), apiJson(`/api/tools/${id}/history`)]);
      // Accepted and snoozed findings are kept apart, so every count and view shows only the open ones.
      const list = Array.isArray(data.findings) ? data.findings : [];
      t.data = { ranAt: data.ranAt || null, findings: list.filter((f) => !f.accepted) };
      t.accepted = list.filter((f) => f.accepted);
      t.tenantErrors = data.tenantErrors && typeof data.tenantErrors === "object" ? data.tenantErrors : {};
      t.history = Array.isArray(history) ? history : [];
      t.error = null;
    } catch (err) {
      t.error = err.message;
    }
    t.loaded = true;
    t.loading = null;
    setNavCount(id, t.data.findings.length);
    return t;
  })();
  return t.loading;
}
async function loadLogs() {
  try {
    const logs = await apiJson("/api/logs?limit=300");
    state.logs = Array.isArray(logs) ? logs : [];
    state.logsAt = new Date();
  } catch (err) {
    /* keep what we have */
  }
  return state.logs;
}

/* ---------- small renderers ---------- */
function setStatus(el, msg, cls) {
  if (!el) return;
  el.className = `status-msg${cls ? " " + cls : ""}`;
  el.textContent = msg || "";
}
function statTile(o) {
  return `<div class="stat"><div class="label">${esc(o.label)}</div><div class="value${o.small ? " sm" : ""}">${esc(o.value)}</div>${o.delta != null && o.delta !== "" ? `<div class="delta ${o.deltaCls || ""}">${esc(o.delta)}</div>` : ""}${o.sub ? `<div class="sub" title="${esc(o.sub)}">${esc(o.sub)}</div>` : ""}</div>`;
}
function subCell(f) {
  const name = f.subscriptionName || f.subscriptionId || "Tenant";
  const showId = Boolean(f.subscriptionName && f.subscriptionId);
  const tenant = multiView() && f.tenantName ? `<span class="tenant-badge">${esc(f.tenantName)}</span>` : "";
  return `<div class="sub-cell"><div class="primary">${tenant}${esc(name)}</div>${showId ? `<div class="secondary">${esc(f.subscriptionId)}</div>` : ""}</div>`;
}
const isNew = (f, ranAt) => Boolean(ranAt && f.firstSeen === ranAt);
function nameCell(f, ranAt, secondary) {
  const sec = secondary != null ? secondary : f.resourceGroup ? `rg ${f.resourceGroup}` : "";
  return `<div class="name-cell"><div class="primary">${esc(f.name || f.id || "")}${isNew(f, ranAt) ? '<span class="new-badge">NEW</span>' : ""}</div>${sec ? `<div class="secondary">${esc(sec)}</div>` : ""}</div>`;
}
function tableHtml(cols, rows, opts) {
  const o = opts || {};
  const head = cols.map((c) => `<th class="${c.cls || ""}">${esc(c.label)}</th>`).join("");
  const body = rows
    .map((r) => {
      const cells = Array.isArray(r) ? r : r.cells;
      const attrs = Array.isArray(r) ? "" : r.attrs || "";
      return `<tr ${attrs}>${cells.map((c, i) => `<td class="${(cols[i] && cols[i].cls) || ""}">${c}</td>`).join("")}</tr>`;
    })
    .join("");
  return `<div class="table-wrap${o.scroll ? " scroll-y" : ""}"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function controlTags(f) {
  const list = Compliance.of(f);
  return list.length ? `<div class="ctl-tags">${list.map((c) => `<span class="ctl ctl-${esc(c.fw)}" title="${esc(FRAMEWORKS[c.fw] + ": " + c.title)}">${esc(c.label)}</span>`).join("")}</div>` : "";
}
// Resilience and Resource settings findings name the PSRule for Azure rule they follow; its page says how to fix it.
const ruleUrl = (f) => (f.rule && /^Azure\.[\w.]+$/.test(f.rule.name || "") ? `https://azure.github.io/PSRule.Rules.Azure/en/rules/${f.rule.name}/` : "");
function ruleLink(f) {
  const url = ruleUrl(f);
  return url ? `<a class="rule-link" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(`PSRule for Azure: ${f.rule.name} (${f.rule.severity}, ${f.rule.pillar})`)}">How to fix ${icon("arrow")}</a>` : "";
}
const acceptButton = (f) => (f.key && canRunFor(f) ? `<button type="button" class="btn small ghost accept-btn" data-accept="${esc(f.key)}" title="Accept or snooze this finding">${icon("check")} Accept</button>` : "");
function moreButton(shown, total, t) {
  if (shown >= total) return "";
  return `<div class="load-more"><button class="btn small ghost" data-more="1">Show more (${fmt.int(total - shown)} left)</button></div>`;
}
function countKinds(findings) {
  const out = {};
  for (const f of findings) out[f.kind] = (out[f.kind] || 0) + 1;
  return out;
}
function kindChips(counts, active) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length < 2 && !active) return "";
  return entries.map(([k, n]) => `<button class="chip${active === k ? " active" : ""}" data-kind="${esc(k)}">${esc(kindLabel(k))} <span class="n">${fmt.int(n)}</span></button>`).join("");
}
// Where an account comes from (stale accounts): a second chip group that
// combines with the kind chips.
const SOURCES = { "ad-synced": "Synced from AD", cloud: "Entra ID only" };
function sourceChips(findings, t) {
  const counts = {};
  for (const f of findings) if (f.source && (!t.filters.kind || f.kind === t.filters.kind)) counts[f.source] = (counts[f.source] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length < 2 && !t.filters.source) return "";
  return `<span class="chip-sep"></span>` + entries.map(([k, n]) => `<button class="chip${t.filters.source === k ? " active" : ""}" data-source="${esc(k)}">${esc(SOURCES[k] || k)} <span class="n">${fmt.int(n)}</span></button>`).join("");
}
function fillSubSelect(all, t) {
  const sel = $("#scan-sub");
  if (!sel) return;
  const key = `${t.data.ranAt}|${all.length}`;
  if (sel.dataset.key !== key) {
    const subs = new Map();
    for (const f of all) if (f.subscriptionId) subs.set(f.subscriptionId, f.subscriptionName || f.subscriptionId);
    const list = [...subs].sort((a, b) => a[1].localeCompare(b[1]));
    sel.innerHTML = `<option value="">All subscriptions</option>` + list.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join("");
    sel.classList.toggle("hidden", list.length === 0);
    sel.dataset.key = key;
    if (t.filters.sub && !subs.has(t.filters.sub)) t.filters.sub = "";
  }
  sel.value = t.filters.sub;
}
function searchText(f) {
  const parts = [f.name, f.id, f.detail, f.resourceGroup, f.tenantName, f.subscriptionName, f.subscriptionId, f.kind, f.upn, f.principalId, f.scope, f.scopeText, f.role, f.probe];
  if (Array.isArray(f.members)) for (const m of f.members) parts.push(m.name, m.upn);
  for (const c of Compliance.of(f)) parts.push(c.label);
  if (f.accepted) parts.push(f.accepted.reason, f.accepted.by);
  return parts.filter(Boolean).join(" ").toLowerCase();
}
function baseFilter(f, t) {
  const fl = t.filters;
  if (fl.kind && f.kind !== fl.kind) return false;
  if (fl.source && f.source !== fl.source) return false;
  if (fl.sub && (f.subscriptionId || "") !== fl.sub) return false;
  if (fl.newOnly && !isNew(f, t.data.ranAt)) return false;
  if (fl.framework && !Compliance.of(f).some((c) => c.fw === fl.framework)) return false;
  if (fl.q && !searchText(f).includes(fl.q)) return false;
  return true;
}
// The subscription is its own column; show the scope below it, readable.
function shortScope(scope) {
  const s = scope || "";
  if (/^\/subscriptions\/[^/]+\/?$/i.test(s)) return "whole subscription";
  const mg = s.match(/\/managementGroups\/([^/]+)$/i);
  if (mg) return `management group ${mg[1]}`;
  if (s === "/") return "tenant root";
  return s.replace(/^\/subscriptions\/[^/]+/i, "").replace(/^\/resourceGroups\//i, "rg ").replace(/\/providers\//i, " / ");
}
function roleClass(role) {
  const r = String(role || "").toLowerCase();
  if (r.startsWith("owner")) return "role-owner";
  if (r.startsWith("user access")) return "role-user";
  if (r.startsWith("contributor")) return "role-contributor";
  return "";
}
const roleBadge = (role) => `<span class="role-badge ${roleClass(role)}">${esc(role || "")}</span>`;
function initials(name) {
  const parts = String(name || "").trim().split(/[\s.@_-]+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/* ---------- routing ---------- */
function parseRoute() {
  const h = (window.location.hash || "#/overview").replace(/^#\/?/, "");
  const [page, ...rest] = h.split("/");
  return { page: page || "overview", arg: rest.join("/") };
}
function navigate(key) {
  window.location.hash = "#/" + key;
}
function render() {
  const r = parseRoute();
  let pageId = null;
  let key = r.page;
  let show = null;
  if (r.page === "overview") {
    pageId = "page-overview";
    show = () => showOverview();
  } else if (r.page === "lookup" && mayRead("access-lookup")) {
    pageId = "page-lookup";
  } else if (r.page === "ipam") {
    pageId = "page-ipam";
    show = () => Ipam.show();
  } else if (r.page === "scan" && TOOL_BY_ID[r.arg] && mayRead(r.arg)) {
    pageId = "page-scan";
    key = `scan/${r.arg}`;
    show = () => showScan(r.arg);
  } else if (r.page === "report") {
    pageId = "page-report";
    show = () => Report.show(r.arg);
  } else if (r.page === "trends") {
    pageId = "page-trends";
    show = () => Trends.show();
  } else if (r.page === "compliance") {
    pageId = "page-compliance";
    show = () => ComplianceView.show();
  } else if (r.page === "cost" && mayRead("cost-history")) {
    pageId = "page-cost";
    show = () => Cost.show();
  } else if (r.page === "audit" && state.me && state.me.isAdmin) {
    pageId = "page-audit";
    show = () => Audit.show();
  } else if (r.page === "load" && state.me && state.me.isAdmin) {
    pageId = "page-load";
    show = () => ServerLoad.show();
  } else if (r.page === "settings" && state.me && state.me.isAdmin) {
    pageId = "page-settings";
    show = () => Settings.show();
  }
  if (!pageId) {
    window.location.replace("#/overview");
    return;
  }
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === pageId));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.route === key));
  // Opening a page in a folded section unfolds it, so the current page is always visible.
  const current = $(`.nav-item[data-route="${CSS.escape(key)}"]`);
  const sec = current && current.closest(".nav-section.closed");
  if (sec) toggleNavSection(sec, true);
  document.body.classList.remove("nav-open");
  if (state.route !== key) {
    window.scrollTo(0, 0);
    // For the admins' audit log: which page this person opened.
    postJson("/api/audit/page", { route: key === "report" && r.arg ? `report/${r.arg}` : key, tenant: state.tenant || undefined }).catch(() => {});
  }
  state.route = key;
  Charts.hideTip();
  if (show) show();
}

/* ---------- shell ---------- */
function buildNav() {
  const me = state.me || {};
  const groups = [
    { label: "", items: [{ route: "overview", label: "Overview", icon: "home" }, { route: "report", label: "Monthly report", icon: "report" }, { route: "trends", label: "Weekly trends", icon: "trend" }, { route: "compliance", label: "Compliance", icon: "policy" }] },
    ...TOOL_GROUPS.map((g) => ({
      label: g.label,
      items: [
        ...(g.id === "access" && mayRead("access-lookup") ? [{ route: "lookup", label: "Access lookup", icon: "search" }] : []),
        ...(g.id === "resources" && !toolOff("ipam") ? [{ route: "ipam", label: "IPAM", icon: "grid" }] : []),
        ...shownTools().filter((t) => t.group === g.id).map((t) => ({ route: `scan/${t.id}`, label: t.label, icon: t.icon, count: true })),
        ...(g.id === "cost" && mayRead("cost-history") ? [{ route: "cost", label: "Cost history", icon: "cost" }] : []),
      ],
    })).filter((g) => g.items.length),
  ];
  if (me.isAdmin) groups.push({ label: "Admin", items: [{ route: "audit", label: "Audit log", icon: "eye" }, { route: "load", label: "Server load", icon: "cpu" },{ route: "settings", label: "Settings", icon: "settings" }] });
  const shut = navClosed();
  const item = (it) => `<a class="nav-item" href="#/${esc(it.route)}" data-route="${esc(it.route)}">${icon(it.icon)}<span>${esc(it.label)}</span>${it.count ? '<span class="nav-count"></span>' : ""}</a>`;
  $("#nav").innerHTML = groups
    .map((g) =>
      g.label
        ? `<div class="nav-section${shut.has(g.label) ? " closed" : ""}" data-section="${esc(g.label)}"><button type="button" class="nav-group" aria-expanded="${!shut.has(g.label)}">${icon("chevron")}<span>${esc(g.label)}</span><span class="nav-group-count"></span></button><div class="nav-items">${g.items.map(item).join("")}</div></div>`
        : g.items.map(item).join("")
    )
    .join("");
  $$("#nav .nav-group").forEach((b) => b.addEventListener("click", () => toggleNavSection(b.parentElement)));
}
// Sidebar sections the viewer folded away, kept in this browser only.
const NAV_CLOSED = "aod.navClosed";
function navClosed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(NAV_CLOSED) || "[]"));
  } catch {
    return new Set();
  }
}
function toggleNavSection(sec, open) {
  const on = open != null ? open : sec.classList.contains("closed");
  sec.classList.toggle("closed", !on);
  sec.querySelector(".nav-group").setAttribute("aria-expanded", String(on));
  const shut = navClosed();
  if (on) shut.delete(sec.dataset.section);
  else shut.add(sec.dataset.section);
  try {
    localStorage.setItem(NAV_CLOSED, JSON.stringify([...shut]));
  } catch {
    // private window: folding just is not remembered
  }
}
function setNavCount(id, n) {
  const el = $(`.nav-item[data-route="scan/${id}"] .nav-count`);
  if (el) el.textContent = fmt.int(n);
  // A folded section shows the open findings of its scans together.
  const sec = el && el.closest(".nav-section");
  if (sec) {
    const total = [...sec.querySelectorAll(".nav-count")].reduce((sum, c) => sum + (Number(c.textContent.replace(/\D/g, "")) || 0), 0);
    sec.querySelector(".nav-group-count").textContent = total ? fmt.int(total) : "";
  }
}
function renderMe() {
  const me = state.me || {};
  $("#me-name").textContent = me.name || "Signed in";
  const areas = Array.isArray(me.areas) ? me.areas : AREAS_ALL;
  const part = areas.length < AREAS_ALL.length ? areas.map(areaLabel).join(", ") : "";
  $("#me-role").textContent = me.isAdmin ? "Admin" : part || "All areas";
  $("#me-role").title = (me.roles || []).join(", ");
  $("#me-avatar").textContent = initials(me.name || "?");
  $("#me-version").textContent = me.version ? `v${me.version}` : "";
}
function wireShell() {
  const open = (on) => document.body.classList.toggle("nav-open", on);
  $("#menu-btn").addEventListener("click", () => open(!document.body.classList.contains("nav-open")));
  $("#scrim").addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") open(false);
  });
}

/* ---------- overview ---------- */
function showOverview() {
  const page = $("#page-overview");
  if (!page.dataset.built) {
    page.innerHTML = `
      <div class="page-head">
        <div><h1>Overview</h1><p class="page-sub">The latest result of every scan, tenant spend and recent activity.</p></div>
        <div class="page-actions"><div class="last-run" id="ov-updated"></div></div>
      </div>
      <div class="stat-row" id="ov-stats"></div>
      <div class="section-title"><h2>Scans</h2><span class="muted small">Click a card to open the scan</span></div>
      <div class="tool-grid" id="ov-tools"></div>
      <div class="overview-grid">
        <div class="card" id="ov-cost"></div>
        <div class="card" id="ov-activity"></div>
      </div>`;
    page.dataset.built = "1";
  }
  renderOverview();
  Promise.all([...shownTools().map((t) => loadTool(t.id)), loadLogs(), mayRead("cost-history") ? Cost.loadIndex().catch(() => null) : null]).then(() => {
    if (state.route === "overview") renderOverview();
  });
}
function renderOverview() {
  const tools = shownTools();
  const loaded = tools.filter((t) => toolState(t.id).loaded);
  let open = 0, added = 0, resolved = 0, errors = 0, neverRan = 0, accepted = 0;
  for (const tool of tools) {
    const t = toolState(tool.id);
    if (t.error) errors++;
    else if (t.loaded && !t.data.ranAt) neverRan++;
    if (tool.info) continue; // the change log is a list of events, not problems
    open += t.data.findings.length;
    accepted += t.accepted.length;
    const last = t.history[t.history.length - 1];
    if (last) {
      added += last.added || 0;
      resolved += last.resolved || 0;
    }
  }
  $("#ov-updated").innerHTML = loaded.length ? `<b>${loaded.length} of ${tools.length}</b> scans loaded` : "Loading…";
  $("#ov-stats").innerHTML =
    statTile({ label: "Open findings", value: fmt.int(open), delta: accepted ? `across all scans · ${fmt.int(accepted)} accepted` : "across all scans" }) +
    statTile({ label: "New in latest runs", value: fmt.int(added), deltaCls: added ? "bad" : "", delta: added ? "need a look" : "nothing new" }) +
    statTile({ label: "Resolved in latest runs", value: fmt.int(resolved), deltaCls: resolved ? "good" : "", delta: resolved ? "gone since the run before" : "no change" }) +
    statTile({ label: "Scan health", value: `${tools.length - errors - neverRan} / ${tools.length}`, deltaCls: errors ? "bad" : "", delta: errors ? `${errors} failed to load` : neverRan ? `${neverRan} never run` : "all scans have results" }) +
    overviewSavedTile();
  $("#ov-tools").innerHTML = tools.map(toolCard).join("");
  for (const el of $$("#ov-tools [data-spark]")) {
    const t = toolState(el.dataset.spark);
    Charts.sparkline(el, t.history.slice(-12).map((h) => h.count));
  }
  renderOverviewCost();
  renderActivity();
}
// Savings done by cleaning up orphaned resources (the "Cleaned up" list of that scan).
function overviewSavings() {
  const t = toolState("orphaned-resources");
  if (!t.loaded || !t.data.ranAt) return null;
  const sv = orSavings(t);
  return sv && sv.data ? sv.data : null;
}
function overviewSavedTile() {
  if (toolOff("orphaned-resources")) return "";
  const d = overviewSavings();
  const saved = d ? orSaved(d.entries) : [];
  return statTile({
    label: "Saved by cleanup",
    value: !d ? "–" : saved.length ? saved.map(([c, m]) => fmt.money(m, c, true)).join(" + ") + " / mo" : "–",
    delta: saved.length ? `about ${saved.map(([c, , so]) => fmt.money(so, c, true)).join(" + ")} so far · ${fmt.int(d.entries.length)} cleaned up` : "deleted orphans count here",
    deltaCls: saved.length ? "good" : "",
  });
}
function overviewSavingsList() {
  const d = overviewSavings();
  if (!d || !d.entries.length) return "";
  const recent = d.entries.slice().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).slice(0, 5);
  return `<div class="ov-savings"><div class="card-head"><h2>${icon("trash")} Savings done</h2><a href="#/scan/orphaned-resources">All cleanups ${icon("arrow")}</a></div>
    <ul class="activity">${recent.map((e) => `<li><span class="dot success"></span><div><div class="act-meta"><span>${esc(fmt.date(e.savedAt))}</span><span>${esc(fmt.money(e.monthlyCost, e.currency))} a month</span></div><div class="act-msg">${esc(savingAction(e))}: ${esc(e.name || "")}</div></div></li>`).join("")}</ul></div>`;
}
function toolCard(tool) {
  const t = toolState(tool.id);
  const n = t.data.findings.length;
  const last = t.history[t.history.length - 1];
  const kinds = Object.entries(countKinds(t.data.findings)).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const delta = last
    ? `<span class="${last.added ? "bad" : ""}">+${fmt.int(last.added)} new</span><span class="${last.resolved ? "good" : ""}">−${fmt.int(last.resolved)} resolved</span>`
    : `<span>No runs yet</span>`;
  const foot = t.error
    ? `<span class="err">${esc(t.error)}</span>`
    : `<span>${t.data.ranAt ? "Ran " + esc(fmt.rel(t.data.ranAt)) : "Never run"}</span><span>${t.accepted.length ? fmt.int(t.accepted.length) + " accepted · " : ""}${t.history.length ? fmt.int(t.history.length) + " runs" : ""}</span>`;
  return `<a class="tool-card" href="#/scan/${esc(tool.id)}">
    <div class="tc-head">${icon(tool.icon)}<span>${esc(tool.label)}</span></div>
    <div class="tc-count"><span class="${n ? "" : "zero"}">${t.loaded ? fmt.int(n) : "…"}</span><small>${tool.id === "architecture" ? "drawing" : tool.info ? `change${n === 1 ? "" : "s"}` : `open finding${n === 1 ? "" : "s"}`}</small></div>
    <div class="tc-delta">${delta}</div>
    <div class="tc-spark" data-spark="${esc(tool.id)}"></div>
    <div class="tc-kinds">${kinds.map(([k, c]) => `${kindBadge(k).replace("</span>", ` ${fmt.int(c)}</span>`)}`).join("")}</div>
    <div class="tc-foot">${foot}</div>
  </a>`;
}
function renderOverviewCost() {
  const el = $("#ov-cost");
  // Without the Cost area the card holds only the cleanup savings, or is left out.
  const costOn = mayRead("cost-history");
  const only = costOn ? "" : overviewSavingsList();
  el.classList.toggle("hidden", !costOn && !only);
  el.parentElement.classList.toggle("one", !costOn && !only);
  if (!costOn) {
    el.innerHTML = only;
    return;
  }
  const s = Cost.summary();
  if (!s || !s.subs.length) {
    el.innerHTML = `<div class="card-head"><h2>${icon("cost")} Tenant spend</h2><a href="#/cost">Open cost history ${icon("arrow")}</a></div><div class="empty-state">No cost data yet.${canRun("cost-history") ? " Refresh it from the cost history page." : ""}</div>` + overviewSavingsList();
    return;
  }
  el.innerHTML = `
    <div class="card-head"><h2>${icon("cost")} Tenant spend</h2><span class="meta">${fmt.int(s.subs.length)} subscription${s.subs.length === 1 ? "" : "s"} · updated ${esc(fmt.rel(s.updatedAt))}</span><a href="#/cost">Open cost history ${icon("arrow")}</a></div>
    <div class="cost-strip">
      ${statTile({ label: "Month to date", value: fmt.money(s.mtd, s.currency, true), small: true })}
      ${statTile({ label: "Forecast this month", value: fmt.money(s.forecast, s.currency, true), small: true })}
      ${statTile({ label: "Last month", value: fmt.money(s.lastMonth, s.currency, true), small: true })}
      ${statTile({ label: "30-day change", value: fmt.pct(s.change30), small: true, deltaCls: s.change30 > 0 ? "bad" : s.change30 < 0 ? "good" : "", delta: s.change30 == null ? "not enough data" : "vs the 30 days before" })}
    </div>
    ${s.currencyNote ? `<div class="note">${esc(s.currencyNote)}</div>` : ""}
    <div class="chart trend-chart" id="ov-cost-chart" style="margin-top:12px"></div>
    <div class="chart-foot"><span>Monthly total, last 13 months</span><span>Current month is in progress</span></div>${overviewSavingsList()}`;
  Charts.columns($("#ov-cost-chart"), {
    data: s.months.map((m) => ({ label: fmt.monthShort(m.month), value: m.total, partial: m.partial, month: m.month })),
    yFormat: Charts.compact,
    emptyText: "No monthly totals yet",
    tooltip: (d) => ({ title: fmt.month(d.month), rows: [{ label: "Total", value: fmt.money(d.value, s.currency) }], note: d.partial ? "Month in progress" : undefined }),
  });
}
function renderActivity() {
  const el = $("#ov-activity");
  const logs = state.logs.slice(0, 12);
  el.innerHTML = `<div class="card-head"><h2>${icon("list")} Recent activity</h2><span class="meta">${state.logsAt ? "updated " + esc(fmt.rel(state.logsAt)) : ""}</span></div>` +
    (logs.length
      ? `<ul class="activity">${logs
          .map(
            (l) => `<li><span class="dot ${esc(l.level || "info")}"></span><div><div class="act-meta"><span>${esc(fmt.rel(l.time))}</span><span>${esc(LOG_TOOLS[l.tool] || (TOOL_BY_ID[l.tool] ? TOOL_BY_ID[l.tool].label : l.tool))}</span></div><div class="act-msg">${esc(l.message)}</div></div></li>`
          )
          .join("")}</ul>`
      : `<div class="empty-state">Nothing logged yet.</div>`);
}

/* ---------- access lookup ---------- */
// Search with part of a name (Enter or the button; no search while typing, to
// keep Graph calls down), then pick one to see its access. A full sign-in name
// or mail in Person mode still looks the person up at once.
const lookupState = { mode: "user", seq: 0 };
const LOOKUP_KINDS = { user: "users", group: "groups" };
function wireLookup() {
  const form = $("#lookup-form");
  const input = $("#lookup-upn");
  const status = $("#lookup-status");
  const out = $("#lookup-result");
  $("#lookup-mode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || b.dataset.mode === lookupState.mode) return;
    lookupState.mode = b.dataset.mode;
    lookupState.seq++;
    $$("#lookup-mode [data-mode]").forEach((x) => x.classList.toggle("active", x === b));
    const user = lookupState.mode === "user";
    input.placeholder = user ? "Name, sign-in name or mail" : "Group name, mail or ID";
    input.setAttribute("aria-label", user ? "Person" : "Group");
    setStatus(status, "");
    out.innerHTML = "";
    input.focus();
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (lookupState.mode === "user" && text.includes("@")) return openUser({ upn: text });
    const found = await runSearch(text);
    if (found && found.length === 1) (lookupState.mode === "user" ? openUser : openGroup)(found[0]);
  });
  out.addEventListener("click", (e) => {
    // The names are links for the keyboard and the look; they must not follow "#" (that is the overview). The CSP
    // blocks inline onclick, so it is stopped here.
    if (e.target.closest(".group-pick")) e.preventDefault();
    const g = e.target.closest("[data-group]");
    if (g) return openGroup({ id: g.dataset.group, tenant: g.dataset.tenant, name: g.dataset.name });
    const u = e.target.closest("[data-user]");
    if (u) openUser({ upn: u.dataset.user, name: u.dataset.name });
  });
}
// Shows the matches; returns them, or null when a newer search took over or it failed.
async function runSearch(text) {
  const seq = ++lookupState.seq;
  const mode = lookupState.mode;
  const kind = LOOKUP_KINDS[mode];
  const status = $("#lookup-status");
  if (text.length < 2) {
    setStatus(status, "Type at least 2 characters.");
    return null;
  }
  setStatus(status, "Searching…");
  try {
    const r = await apiJson(`/api/tools/access-lookup/${kind}?q=${encodeURIComponent(text)}`);
    if (seq !== lookupState.seq) return null;
    const list = r[kind] || [];
    setStatus(status, list.length ? "" : mode === "user" ? "No person matches that." : "No group matches that.");
    $("#lookup-result").innerHTML = list.length ? (mode === "user" ? userListHtml(r) : groupListHtml(r)) : "";
    return list;
  } catch (err) {
    if (seq === lookupState.seq) setStatus(status, err.message, "error");
    return null;
  }
}
async function openUser(u) {
  const seq = ++lookupState.seq;
  const status = $("#lookup-status");
  setStatus(status, `Looking up ${u.name || u.upn}…`);
  try {
    const r = await apiJson(`/api/tools/access-lookup/run?upn=${encodeURIComponent(u.upn)}`);
    if (seq !== lookupState.seq) return;
    setStatus(status, "");
    $("#lookup-result").innerHTML = lookupHtml(r);
    window.scrollTo(0, 0);
  } catch (err) {
    if (seq === lookupState.seq) setStatus(status, err.message, "error");
  }
}
async function openGroup(g) {
  const seq = ++lookupState.seq;
  const status = $("#lookup-status");
  setStatus(status, `Reading ${g.name || "the group"}…`);
  try {
    const r = await apiJson(`/api/tools/access-lookup/group/${encodeURIComponent(g.id)}?in=${encodeURIComponent(g.tenant || "")}&name=${encodeURIComponent(g.name || "")}`);
    if (seq !== lookupState.seq) return;
    setStatus(status, "");
    $("#lookup-result").innerHTML = groupHtml(r);
    window.scrollTo(0, 0);
  } catch (err) {
    if (seq === lookupState.seq) setStatus(status, err.message, "error");
  }
}
function lookupTenantsHtml(r, ok) {
  return Array.isArray(r.tenants) && r.tenants.length > 1
    ? `<div class="inline-list lookup-tenants">${r.tenants.map((t) => `<span class="tag" title="${esc(t.error || "")}"><span class="dot ${t.status === ok ? "success" : t.status === "error" ? "error" : ""}"></span>${esc(t.name)}: ${esc(t.status)}</span>`).join("")}</div>`
    : "";
}
// How a role reaches the person or group: direct, or the chain of groups,
// the group they are a direct member of first and the group holding the role last.
function viaHtml(x, selfLabel) {
  if (x.via === "direct") return `<span class="text-2">${esc(selfLabel)}</span>`;
  const path = Array.isArray(x.path) && x.path.length ? x.path : [String(x.via || "").replace(/^group: /, "")];
  const pim = x.pimGroup ? ` <span class="tag" title="Eligible ${esc(x.pimGroup)} of ${esc(path[0])} through PIM for Groups">PIM group</span>` : "";
  return `<span class="text-2">${path.map(esc).join(' <span class="muted">›</span> ')}</span>${x.nested ? ' <span class="tag">nested</span>' : ""}${pim}`;
}
// PIM state of a role: eligible (can activate), activated now, active until a
// date, or plain active.
function pimStateHtml(x) {
  const until = x.end ? ` until ${esc(fmt.date(x.end))}` : "";
  if (x.state === "eligible") return `<span class="tag" title="Can activate this role with PIM">eligible</span><span class="text-2">${x.end ? until : " · no end"}</span>`;
  if (x.state === "activated") return `<span class="text-2" title="Activated with PIM">activated${until}</span>`;
  if (x.state === "time-bound") return `<span class="text-2" title="Assigned in PIM with an end date">active${until}</span>`;
  return '<span class="text-2">active</span>';
}
const notesHtml = (notes) => (Array.isArray(notes) ? notes : []).map((n) => `<div class="status-msg">${esc(n)}</div>`).join("");
const eligibleCount = (list) => list.filter((x) => x.state === "eligible").length;
function azureRolesCard(r, selfLabel, emptyText) {
  const a = Array.isArray(r.assignments) ? r.assignments : [];
  const eligible = eligibleCount(a);
  return `
    <div class="card">
      <div class="card-head"><h2>Azure roles</h2><span class="meta">${fmt.int(a.length - eligible)} active · ${fmt.int(eligible)} eligible (PIM) · Via: the group they are in first, the group given the role last</span></div>
      ${notesHtml(r.azureNotes)}
      ${
        a.length
          ? tableHtml(
              [{ label: "Role" }, { label: "State" }, { label: "Via" }, { label: "Subscription" }, { label: "Scope" }],
              a.map((x) => [roleBadge(x.role), pimStateHtml(x), viaHtml(x, selfLabel), subCell(x), `<span class="detail-cell">${esc(shortScope(x.scope))}</span>`])
            )
          : `<div class="empty-state">${esc(emptyText)}</div>`
      }
    </div>`;
}
function entraRolesCard(r, selfLabel, emptyText) {
  const list = Array.isArray(r.entraRoles) ? r.entraRoles : [];
  const eligible = eligibleCount(list);
  const multi = list.some((x) => x.tenantName);
  return `
    <div class="card">
      <div class="card-head"><h2>Entra ID roles</h2><span class="meta">${fmt.int(list.length - eligible)} active · ${fmt.int(eligible)} eligible (PIM)</span></div>
      ${notesHtml(r.entraNotes)}
      ${
        list.length
          ? tableHtml(
              [{ label: "Role" }, { label: "State" }, { label: "Via" }, { label: "Scope" }, ...(multi ? [{ label: "Tenant" }] : [])],
              list.map((x) => [
                `${roleBadge(x.role)}${x.builtIn ? "" : ' <span class="tag">custom</span>'}`,
                pimStateHtml(x),
                viaHtml(x, selfLabel),
                `<span class="detail-cell">${esc(x.scope)}</span>`,
                ...(multi ? [esc(x.tenantName || "")] : []),
              ])
            )
          : `<div class="empty-state">${esc(emptyText)}</div>`
      }
    </div>`;
}
function membershipsCard(groups, title, emptyText, notes) {
  const list = groups.map((g) => (typeof g === "string" ? { name: g, direct: true } : g));
  const until = (g) => (g.end ? ` until ${fmt.date(g.end)}` : "");
  const tag = (g) => {
    const name = g.tenantName ? `${g.name} (${g.tenantName})` : g.name;
    const how =
      g.pim === "eligible"
        ? `eligible ${g.access || "member"} through PIM for Groups${g.end ? until(g) : ", no end"}`
        : `${g.direct ? "direct member" : g.through ? `nested, through ${g.through.join(" › ")}` : "nested, through another group"}${g.pim === "activated" ? `, activated with PIM${until(g)}` : g.pim === "time-bound" ? until(g) : ""}`;
    const mark = g.pim === "eligible" ? `eligible${g.access === "owner" ? " owner" : ""}` : g.pim === "activated" ? "activated" : !g.direct ? "nested" : "";
    return `<span class="tag" title="${esc(how)}">${esc(name)}${mark ? ` <span class="muted">${mark}</span>` : ""}</span>`;
  };
  const eligible = list.filter((g) => g.pim === "eligible");
  const direct = list.filter((g) => g.direct && g.pim !== "eligible");
  const nested = list.filter((g) => !g.direct);
  return `
    <div class="card">
      <div class="card-head"><h2>${esc(title)}</h2><span class="meta">${fmt.int(direct.length)} direct · ${fmt.int(nested.length)} nested${eligible.length ? ` · ${fmt.int(eligible.length)} eligible (PIM)` : ""} (hover one to see the way in)</span></div>
      ${notesHtml(notes)}
      ${list.length ? `<div class="inline-list">${[...direct, ...nested, ...eligible].map(tag).join("")}</div>` : `<div class="empty-state">${esc(emptyText)}</div>`}
    </div>`;
}
function accessStats(r) {
  const a = Array.isArray(r.assignments) ? r.assignments : [];
  const e = Array.isArray(r.entraRoles) ? r.entraRoles : [];
  const viaGroups = a.filter((x) => x.via !== "direct").length;
  const nested = [...a, ...e].filter((x) => x.nested).length;
  const subs = new Set(a.map((x) => x.subscriptionId).filter(Boolean)).size;
  const owners = a.filter((x) => /^owner/i.test(x.role || "")).length;
  const globalAdmin = e.some((x) => /^global administrator$/i.test(x.role || ""));
  const eligibleOwners = a.filter((x) => /^owner/i.test(x.role || "") && x.state === "eligible").length;
  return `
      ${statTile({ label: "Azure roles", value: fmt.int(a.length), delta: `${fmt.int(eligibleCount(a))} eligible · ${fmt.int(subs)} subscription${subs === 1 ? "" : "s"}` })}
      ${statTile({ label: "Entra roles", value: fmt.int(e.length), deltaCls: globalAdmin ? "bad" : "", delta: globalAdmin ? "includes Global Administrator" : `${fmt.int(eligibleCount(e))} eligible` })}
      ${statTile({ label: "Via groups", value: fmt.int(viaGroups + e.filter((x) => x.via !== "direct").length), delta: nested ? `${fmt.int(nested)} through nested groups` : "" })}
      ${statTile({ label: "Owner", value: fmt.int(owners), deltaCls: owners - eligibleOwners ? "bad" : "", delta: eligibleOwners ? `${fmt.int(eligibleOwners)} eligible (PIM)` : owners ? "highest Azure privilege" : "" })}`;
}
function lookupHtml(r) {
  const user = r.user || {};
  return `
    <div class="person"><div class="avatar">${esc(initials(user.displayName || user.upn))}</div><div><div class="p-name">${esc(user.displayName || "")}</div><div class="p-upn">${esc(user.upn || "")}</div></div></div>
    ${lookupTenantsHtml(r, "found")}
    <div class="stat-row">${accessStats(r)}</div>
    ${azureRolesCard(r, "direct", "No Azure roles found for this person.")}
    ${entraRolesCard(r, "direct", "No Entra ID roles.")}
    ${membershipsCard(Array.isArray(r.groups) ? r.groups : [], "Group memberships", "Not a member of any group.", r.groupNotes)}`;
}
function groupListHtml(r) {
  const groups = r.groups || [];
  const multi = Array.isArray(r.tenants) && r.tenants.length > 1;
  return `
    ${lookupTenantsHtml(r, "searched")}
    <div class="card">
      <div class="card-head"><h2>Groups</h2><span class="meta">${fmt.int(groups.length)} · pick one to see what it gives</span></div>
      ${tableHtml(
        [{ label: "Group" }, { label: "Description" }, ...(multi ? [{ label: "Tenant" }] : [])],
        groups.map((g) => ({
          attrs: `class="clickable" data-group="${esc(g.id)}" data-tenant="${esc(g.tenant || "")}" data-name="${esc(g.name)}"`,
          cells: [
            `<a href="#" class="group-pick">${esc(g.name)}</a>`,
            `<span class="detail-cell">${esc(g.description || g.mail || "")}</span>`,
            ...(multi ? [esc(g.tenantName || "")] : []),
          ],
        }))
      )}
    </div>`;
}
// A guest's sign-in name differs per tenant, so a guest is looked up by mail.
function userListHtml(r) {
  const users = r.users || [];
  const multi = Array.isArray(r.tenants) && r.tenants.length > 1;
  return `
    ${lookupTenantsHtml(r, "searched")}
    <div class="card">
      <div class="card-head"><h2>People</h2><span class="meta">${fmt.int(users.length)} · pick one to see their access</span></div>
      ${tableHtml(
        [{ label: "Name" }, { label: "Sign-in name" }, { label: "Job" }, ...(multi ? [{ label: "Tenant" }] : [])],
        users.map((u) => ({
          attrs: `class="clickable" data-user="${esc(u.guest && u.mail ? u.mail : u.upn)}" data-name="${esc(u.name)}"`,
          cells: [
            `<a href="#" class="group-pick">${esc(u.name)}</a>${u.guest ? ' <span class="tag">guest</span>' : ""}`,
            `<span class="text-2">${esc(u.upn)}</span>`,
            `<span class="detail-cell">${esc([u.jobTitle, u.department].filter(Boolean).join(" · "))}</span>`,
            ...(multi ? [esc(u.tenantName || "")] : []),
          ],
        }))
      )}
    </div>`;
}
function groupHtml(r) {
  const g = r.group || {};
  const members = Array.isArray(r.members) ? r.members : [];
  const kinds = [g.security ? "Security group" : "", g.m365 ? "Microsoft 365 group" : ""].filter(Boolean).join(" · ");
  const groupMembers = members.filter((m) => m.type === "group").length;
  return `
    <div class="person"><div class="avatar">${esc(initials(g.name))}</div><div><div class="p-name">${esc(g.name || "")}</div><div class="p-upn">${esc([kinds, g.mail, r.tenantName].filter(Boolean).join(" · "))}</div>${g.description ? `<div class="text-2">${esc(g.description)}</div>` : ""}</div></div>
    <div class="stat-row">
      ${accessStats(r)}
      ${statTile({ label: "Members", value: `${fmt.int(members.length)}${r.moreMembers ? "+" : ""}`, delta: groupMembers ? `${fmt.int(groupMembers)} of them groups` : "direct members" })}
    </div>
    ${azureRolesCard(r, "this group", "This group gives no Azure roles, directly or through the groups it sits in.")}
    ${entraRolesCard(r, "this group", "This group gives no Entra ID roles.")}
    ${membershipsCard(Array.isArray(r.groups) ? r.groups : [], "Member of", "This group is not inside any other group.", r.groupNotes)}
    <div class="card">
      <div class="card-head"><h2>Members</h2><span class="meta">${fmt.int(members.length)}${r.moreMembers ? " (first 500)" : ""} · direct members; the members of a group listed here get the same roles</span></div>
      ${
        members.length
          ? tableHtml(
              [{ label: "Name" }, { label: "Type" }, { label: "Sign-in name" }],
              members.map((m) => [esc(m.name), `<span class="text-2">${esc(m.type)}</span>`, `<span class="text-2">${esc(m.upn)}</span>`])
            )
          : `<div class="empty-state">No members.</div>`
      }
    </div>`;
}

/* ---------- scan pages ---------- */
// Each scan's section in docs/tools.md (the heading is the tool's label; GitHub's anchor rule).
const DOCS_TOOLS = "https://github.com/Gooseankles/cirrus-watch/blob/main/docs/tools.md";
function docLink(label) {
  const anchor = String(label).toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");
  return `<a class="page-doc" href="${DOCS_TOOLS}#${esc(anchor)}" target="_blank" rel="noopener">${icon("report")} What this scan checks</a>`;
}
function scanSkeleton(tool) {
  return `
    <div class="page-head">
      <div><h1>${esc(tool.label)}</h1><p class="page-sub">${esc(tool.sub)}</p>${docLink(tool.label)}</div>
      <div class="page-actions"><div class="last-run" id="scan-lastrun"></div><button class="btn primary" id="scan-run">${icon("play")} Run now</button></div>
    </div>
    <div class="status-msg" id="scan-status"></div>
    <div class="status-msg" id="scan-tenant-errors"></div>
    <div id="scan-perms"></div>
    <div class="stat-row" id="scan-stats"></div>
    <div class="card">
      <div class="card-head">
        <h2>Findings <span class="meta" id="scan-count"></span></h2>
        <div class="card-tools">
          <input class="input search" id="scan-q" type="search" placeholder="Search name, detail, subscription" />
          <select class="select" id="scan-sub"><option value="">All subscriptions</option></select>
          <span id="scan-extra" class="card-tools"></span>
          <select class="select" id="scan-fw" data-filter="framework" title="Only findings that bear on this framework">
            <option value="">All findings</option>${Object.entries(FRAMEWORKS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}
          </select>
          <button class="chip" id="scan-new" data-filter="newOnly">${icon("alert")} New this run</button>
          <button class="chip" id="scan-accepted" data-filter="accepted">${icon("check")} Accepted <span class="n" id="scan-accepted-n"></span></button>
          <button class="chip hidden" id="scan-csv" title="Download the findings these filters show as a CSV file">${icon("download")} CSV</button>
        </div>
      </div>
      <div class="inline-list" id="scan-kinds"></div>
      <div id="scan-body"></div>
    </div>
    <div class="card" id="scan-hist-card">
      <div class="card-head"><h2>${icon("trend")} History</h2><span class="meta" id="scan-hist-meta"></span></div>
      <div class="hist-grid">
        <div><div class="chart hist-chart" id="scan-chart"></div><div class="chart-foot" id="scan-chart-note"></div></div>
        <div class="hist-runs" id="scan-runs"></div>
      </div>
      <div class="hist-detail" id="scan-run-detail"></div>
    </div>`;
}
function wireScan() {
  const page = $("#page-scan");
  const cur = () => toolState(page.dataset.tool);
  page.addEventListener("input", (e) => {
    if (e.target.id === "scan-q") {
      cur().filters.q = e.target.value.trim().toLowerCase();
      cur().shown = 150;
      renderFindings(page.dataset.tool);
    }
  });
  page.addEventListener("change", (e) => {
    const t = cur();
    if (e.target.id === "scan-sub") t.filters.sub = e.target.value;
    else if (e.target.dataset.filter) t.filters[e.target.dataset.filter] = e.target.value;
    else return;
    t.shown = 150;
    renderFindings(page.dataset.tool);
  });
  page.addEventListener("click", (e) => {
    const t = cur();
    const id = page.dataset.tool;
    const el = e.target.closest("[data-kind],[data-source],[data-filter],[data-view],[data-ranat],[data-more],[data-toggle],[data-accept],[data-unaccept],#scan-run,#scan-csv");
    if (!el) return;
    if (el.id === "scan-run") return runTool(id);
    if (el.id === "scan-csv") return downloadScanCsv(id);
    if (el.dataset.accept) return openAccept(id, el.dataset.accept);
    if (el.dataset.unaccept) return reopenFinding(id, el.dataset.unaccept, el);
    if (el.tagName === "SELECT") return;
    if (el.dataset.kind !== undefined) {
      t.filters.kind = t.filters.kind === el.dataset.kind ? "" : el.dataset.kind;
    } else if (el.dataset.source !== undefined) {
      t.filters.source = t.filters.source === el.dataset.source ? "" : el.dataset.source;
    } else if (el.dataset.filter === "newOnly") {
      t.filters.newOnly = !t.filters.newOnly;
    } else if (el.dataset.filter === "accepted") {
      t.filters.accepted = !t.filters.accepted;
      t.filters.kind = "";
      t.filters.source = "";
    } else if (el.dataset.view) {
      t.filters.view = el.dataset.view;
      t.viewPicked = true;
      t.filters.kind = "";
      t.filters.source = "";
    } else if (el.dataset.ranat) {
      return selectRun(id, el.dataset.ranat);
    } else if (el.dataset.more) {
      t.shown += 150;
    } else if (el.dataset.toggle) {
      const key = el.dataset.toggle;
      // Policy details are drawn only when opened.
      if (key.startsWith("pa:")) {
        if (t.open.has(key)) t.open.delete(key);
        else t.open.add(key);
        return renderFindings(id);
      }
      const row = page.querySelector(`tr[data-members="${CSS.escape(key)}"]`);
      const open = t.open.has(key);
      if (open) t.open.delete(key);
      else t.open.add(key);
      if (row) row.classList.toggle("hidden", open);
      el.classList.toggle("active", !open);
      return;
    } else return;
    t.shown = el.dataset.more ? t.shown : 150;
    renderFindings(id);
  });
}
function showScan(id) {
  const page = $("#page-scan");
  const tool = TOOL_BY_ID[id];
  const t = toolState(id);
  if (page.dataset.tool !== id) {
    page.innerHTML = scanSkeleton(tool);
    page.dataset.tool = id;
    $("#scan-q").value = t.filters.q;
    $("#scan-fw").value = t.filters.framework;
  }
  renderScan(id);
  loadTool(id).then(() => {
    if (state.route === `scan/${id}`) {
      if (!t.selectedRun && t.history.length) t.selectedRun = t.history[t.history.length - 1].ranAt;
      renderScan(id);
    }
  });
}
function renderScan(id) {
  renderFindings(id);
  renderHistory(id);
}
function renderFindings(id) {
  const t = toolState(id);
  const tool = TOOL_BY_ID[id];
  const view = VIEWS[id] || GENERIC;
  const runner = canRun(id);
  renderRunState(id);
  $("#scan-lastrun").innerHTML = t.data.ranAt
    ? `Last run <b title="${esc(t.data.ranAt)}">${esc(fmt.rel(t.data.ranAt))}</b><br>${esc(tool.schedule)}`
    : `<b>Never run</b><br>${esc(tool.schedule)}`;
  const all = t.data.findings;
  $("#scan-csv").classList.toggle("hidden", !t.loaded || !t.data.ranAt || Boolean(t.error));
  if (!t.loaded) {
    $("#scan-body").innerHTML = `<div class="empty-state">Loading…</div>`;
    return;
  }
  // A tenant whose last scan failed keeps its earlier results; say so.
  const failed = Object.entries(t.tenantErrors || {});
  renderPermsHint(id);
  setStatus($("#scan-tenant-errors"), failed.length ? `Last scan failed in ${failed.map(([k, e]) => `${e.tenantName || k} (${fmt.rel(e.at)}: ${e.error})`).join("; ")}. Its earlier results are shown.` : "", "error");
  if (t.error) {
    $("#scan-stats").innerHTML = "";
    $("#scan-body").innerHTML = `<div class="empty-state big"><h3>Could not load this scan</h3><p class="muted">${esc(t.error)}</p></div>`;
    return;
  }
  if (!t.data.ranAt) {
    $("#scan-stats").innerHTML = "";
    $("#scan-kinds").innerHTML = "";
    $("#scan-extra").innerHTML = "";
    $("#scan-count").textContent = "";
    $("#scan-body").innerHTML = `<div class="empty-state big"><h3>No results yet</h3><p>This scan has not run on this server.${runner ? " Run it now, or wait for the schedule (" + esc(tool.schedule.toLowerCase()) + ")." : " It runs on schedule: " + esc(tool.schedule.toLowerCase()) + "."}</p></div>`;
    return;
  }
  $("#scan-stats").innerHTML = view.stats(all, t);
  fillSubSelect([...all, ...t.accepted], t);
  $("#scan-new").classList.toggle("active", t.filters.newOnly);
  $("#scan-accepted").classList.toggle("active", t.filters.accepted);
  $("#scan-accepted").classList.toggle("hidden", !t.accepted.length && !t.filters.accepted);
  $("#scan-accepted-n").textContent = fmt.int(t.accepted.length);
  if (t.filters.accepted) {
    $("#scan-extra").innerHTML = "";
    $("#scan-kinds").innerHTML = kindChips(countKinds(t.accepted), t.filters.kind);
    const shown = t.accepted.filter((f) => baseFilter(f, t));
    $("#scan-count").textContent = `${fmt.int(shown.length)} accepted`;
    $("#scan-body").innerHTML = shown.length ? acceptedBody(shown, t) : `<div class="empty-state">No accepted findings match these filters.</div>`;
    return;
  }
  const scoped = view.scope ? all.filter((f) => view.scope(f, t)) : all;
  const showKinds = view.showKinds ? view.showKinds(t) : true;
  $("#scan-kinds").innerHTML = showKinds ? kindChips(countKinds(scoped), t.filters.kind) + sourceChips(scoped, t) : "";
  $("#scan-extra").innerHTML = view.extra ? view.extra(all, t) : "";
  // A view with pages of its own (IPAM's networks and free ranges) shows them
  // in place of the findings table.
  const page = view.page ? view.page(all, t) : null;
  if (page != null) {
    $("#scan-count").textContent = "";
    $("#scan-body").innerHTML = page;
    return;
  }
  const shown = scoped.filter((f) => baseFilter(f, t));
  $("#scan-count").textContent = all.length ? `${fmt.int(shown.length)} of ${fmt.int(all.length)}` : "";
  const acceptedNote = t.accepted.length ? ` ${fmt.int(t.accepted.length)} accepted or snoozed finding${t.accepted.length === 1 ? " is" : "s are"} not counted.` : "";
  $("#scan-body").innerHTML = all.length
    ? shown.length
      ? view.body(shown, t)
      : `<div class="empty-state">No findings match these filters.</div>`
    : `<div class="empty-state big"><h3>All clear</h3><p>The last run found nothing open.${esc(acceptedNote)}</p></div>`;
}

/* CSV export of one scan: the findings the current filters show (the accepted list when that is open). */
function csvCell(v) {
  let s = v == null ? "" : String(v);
  // A cell Excel would read as a formula is kept as text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function scanCsvRows(id) {
  const t = toolState(id);
  const view = VIEWS[id] || GENERIC;
  if (t.filters.accepted) return { accepted: true, rows: t.accepted.filter((f) => baseFilter(f, t)) };
  const all = t.data.findings;
  const scoped = view.scope ? all.filter((f) => view.scope(f, t)) : all;
  return { accepted: false, rows: scoped.filter((f) => baseFilter(f, t)) };
}
function scanCsv(rows, ranAt, accepted) {
  const has = (k) => rows.some((f) => f[k] != null && f[k] !== "");
  const cols = [];
  if (has("tenantName") || has("tenant")) cols.push(["Tenant", (f) => f.tenantName || f.tenant]);
  cols.push(["Kind", (f) => kindLabel(f.kind)], ["Severity", (f) => kindSev(f.kind)], ["Name", (f) => f.name || f.id], ["Detail", (f) => f.detail]);
  if (has("subscriptionId")) cols.push(["Subscription", (f) => f.subscriptionName], ["Subscription ID", (f) => f.subscriptionId]);
  if (has("resourceGroup")) cols.push(["Resource group", (f) => f.resourceGroup]);
  if (has("scopeText") || has("scope")) cols.push(["Scope", (f) => f.scopeText || f.scope]);
  if (has("monthlyCost")) cols.push(["Cost a month (list price)", (f) => (f.monthlyCost == null ? "" : Math.round(f.monthlyCost))], ["Currency", (f) => (f.monthlyCost == null ? "" : f.currency)]);
  if (has("role")) cols.push(["Role", (f) => f.role]);
  if (has("upn")) cols.push(["User", (f) => f.upn]);
  if (has("rule")) cols.push(["Rule", (f) => f.rule && f.rule.name], ["Pillar", (f) => f.rule && f.rule.pillar], ["How to fix", ruleUrl]);
  cols.push(["First seen", (f) => f.firstSeen], ["New this run", (f) => (isNew(f, ranAt) ? "yes" : "")]);
  cols.push(["Controls", (f) => Compliance.of(f).map((c) => c.label).join(", ")]);
  if (accepted) cols.push(["Accepted reason", (f) => f.accepted && f.accepted.reason], ["Accepted by", (f) => f.accepted && f.accepted.by], ["Accepted at", (f) => f.accepted && f.accepted.at], ["Until", (f) => f.accepted && f.accepted.until]);
  cols.push(["ID", (f) => f.id]);
  const lines = [cols.map(([h]) => csvCell(h)).join(",")];
  for (const f of rows) lines.push(cols.map(([, get]) => csvCell(get(f))).join(","));
  // The BOM makes Excel read the file as UTF-8 (æ, ø, å).
  return "﻿" + lines.join("\r\n") + "\r\n";
}
function downloadScanCsv(id) {
  const t = toolState(id);
  const { accepted, rows } = scanCsvRows(id);
  const csv = scanCsv(rows, t.data.ranAt, accepted);
  const day = new Date().toISOString().slice(0, 10);
  const name = `${id}${accepted ? "-accepted" : ""}-${(state.tenant || "all-tenants").replace(/[^\w-]/g, "")}-${day}.csv`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* accepted and snoozed findings */
function acceptedUntil(a) {
  if (!a.until) return `<span class="text-2">until reopened</span>`;
  const days = Math.ceil((Date.parse(a.until) - Date.now()) / 86400000);
  return `<div class="nowrap">until ${esc(fmt.date(a.until))}</div><div class="secondary">${fmt.int(days)} day${days === 1 ? "" : "s"} left</div>`;
}
function acceptedBody(shown, t) {
  const hasSubs = shown.some((f) => f.subscriptionId);
  const slice = shown.slice(0, t.shown);
  const cols = [{ label: "Kind" }, { label: "Name" }];
  if (hasSubs) cols.push({ label: "Subscription" });
  cols.push({ label: "Reason" }, { label: "Snoozed", cls: "nowrap" }, { label: "By" }, { label: "" });
  const rows = slice.map((f) => {
    const a = f.accepted || {};
    const r = [kindBadge(f.kind), nameCell(f, null, f.detail || (f.resourceGroup ? `rg ${f.resourceGroup}` : ""))];
    if (hasSubs) r.push(subCell(f));
    r.push(
      `<span class="detail-cell">${esc(a.reason || "")}</span>`,
      acceptedUntil(a),
      `<div>${esc(a.by || "")}</div><div class="secondary">${esc(fmt.date(a.at))}</div>`,
      canRunFor(f) ? `<button type="button" class="btn small ghost" data-unaccept="${esc(f.key)}">Reopen</button>` : ""
    );
    return r;
  });
  return tableHtml(cols, rows) + moreButton(slice.length, shown.length, t) + `<div class="note">Accepted findings stay in the scan results but do not count as open. A snoozed one counts again from its end date.</div>`;
}
function findAny(t, key) {
  return t.data.findings.find((f) => f.key === key) || t.accepted.find((f) => f.key === key) || null;
}
async function reloadTool(id) {
  const t = toolState(id);
  t.loaded = false;
  t.loading = null;
  await loadTool(id);
  if (state.route === `scan/${id}`) renderScan(id);
}
async function reopenFinding(id, key, btn) {
  const f = findAny(toolState(id), key);
  if (!f) return;
  btn.disabled = true;
  try {
    await postJson(`/api/tools/${id}/unaccept`, { key, tenant: f.tenant || "home" });
    await reloadTool(id);
  } catch (err) {
    btn.disabled = false;
    setStatus($("#scan-status"), `Could not reopen: ${err.message}`, "error");
  }
}
function acceptDialog() {
  let dlg = $("#accept-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "accept-dialog";
  dlg.className = "dialog";
  dlg.innerHTML = `
    <form class="accept-form" method="dialog">
      <h3>Accept finding</h3>
      <div class="accept-what"></div>
      <label>Why is this fine?<textarea class="input" name="reason" maxlength="500" rows="3" required placeholder="e.g. Public IP is the VPN gateway, approved by the network team"></textarea></label>
      <label>For how long
        <select class="select" name="for">
          <option value="30">30 days</option><option value="90" selected>90 days</option><option value="180">6 months</option><option value="365">1 year</option>
          <option value="date">Until a date…</option><option value="">Until someone reopens it</option>
        </select>
      </label>
      <input class="input hidden" type="date" name="date" />
      <div class="status-msg" data-msg></div>
      <div class="dialog-actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn primary">Accept</button></div>
    </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector("form");
  form.elements.for.addEventListener("change", () => form.elements.date.classList.toggle("hidden", form.elements.for.value !== "date"));
  dlg.querySelector("[data-cancel]").addEventListener("click", () => dlg.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = dlg.querySelector("[data-msg]");
    const reason = form.elements.reason.value.trim();
    const pick = form.elements.for.value;
    let until = null;
    if (pick === "date") until = form.elements.date.value || "";
    else if (pick) until = new Date(Date.now() + Number(pick) * 86400000).toISOString().slice(0, 10);
    if (!reason) return setStatus(msg, "Give a reason.", "error");
    if (until === "") return setStatus(msg, "Pick a date.", "error");
    const { id, f } = dlg._target || {};
    if (!f) return dlg.close();
    form.querySelector("[type=submit]").disabled = true;
    try {
      await postJson(`/api/tools/${id}/accept`, { key: f.key, tenant: f.tenant || "home", reason, until });
      dlg.close();
      await reloadTool(id);
    } catch (err) {
      setStatus(msg, err.message, "error");
    }
    form.querySelector("[type=submit]").disabled = false;
  });
  return dlg;
}
function openAccept(id, key) {
  const f = findAny(toolState(id), key);
  if (!f) return;
  const dlg = acceptDialog();
  const form = dlg.querySelector("form");
  form.reset();
  form.elements.date.classList.add("hidden");
  form.elements.date.min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  setStatus(dlg.querySelector("[data-msg]"), "");
  dlg.querySelector(".accept-what").innerHTML = `${kindBadge(f.kind)} <b>${esc(f.name || f.id || "")}</b>${f.subscriptionName || f.subscriptionId ? ` <span class="muted">· ${esc(f.subscriptionName || f.subscriptionId)}</span>` : ""}<div class="secondary">${esc(f.detail || "")}</div>`;
  dlg._target = { id, f };
  dlg.showModal();
  form.elements.reason.focus();
}

/* generic view */
function genericStats(all, t) {
  const last = t.history[t.history.length - 1];
  const subs = new Set(all.map((f) => f.subscriptionId).filter(Boolean)).size;
  const kinds = Object.keys(countKinds(all)).length;
  const fresh = all.filter((f) => isNew(f, t.data.ranAt)).length;
  const oldest = all.reduce((m, f) => (f.firstSeen && new Date(f.firstSeen) < m ? new Date(f.firstSeen) : m), new Date());
  const oldestDays = Math.floor((Date.now() - oldest.getTime()) / 86400000);
  return (
    statTile({ label: "Open findings", value: fmt.int(all.length), delta: last ? `+${fmt.int(last.added)} new · −${fmt.int(last.resolved)} resolved in this run` : "" }) +
    statTile({ label: "New this run", value: fmt.int(fresh), deltaCls: fresh ? "bad" : "", delta: fresh ? "first seen in the last run" : "nothing new" }) +
    statTile({ label: "Subscriptions affected", value: fmt.int(subs), delta: subs ? "" : "tenant-level only" }) +
    statTile({ label: "Kinds", value: fmt.int(kinds) }) +
    statTile({ label: "Oldest open", value: all.length ? `${fmt.int(oldestDays)} d` : "–", delta: all.length ? "first seen " + fmt.date(oldest) : "" })
  );
}
function genericColumns(ranAt, hasSubs, hasExpiry) {
  const cols = [{ label: "Kind" }, { label: "Name" }];
  if (hasSubs) cols.push({ label: "Subscription" });
  if (hasExpiry) cols.push({ label: "Expiry", cls: "nowrap" });
  cols.push({ label: "Detail" }, { label: "First seen", cls: "nowrap" });
  cols.push({ label: "" });
  return cols;
}
// "Expired <date>" (red) or "Expires <date>", with how long ago / how long left.
function expiryCell(f) {
  if (!f.expires) return f.kind === "kv-no-expiry" ? `<span class="muted">No expiry</span>` : "";
  const at = new Date(f.expires);
  const days = Math.round((at.getTime() - Date.now()) / 86400000);
  const past = days < 0 || at.getTime() <= Date.now();
  const when = past ? (days === 0 ? "today" : `${fmt.int(-days)} day${days === -1 ? "" : "s"} ago`) : days === 0 ? "today" : `in ${fmt.int(days)} day${days === 1 ? "" : "s"}`;
  return `<div class="nowrap${past ? " bad" : ""}" title="${esc(f.expires)}">${past ? "Expired" : "Expires"} ${esc(fmt.date(f.expires))}</div><div class="secondary">${esc(when)}</div>`;
}
function genericRow(f, ranAt, hasSubs, hasExpiry) {
  const sec = f.role ? `${f.role} · ${shortScope(f.scope)}` : f.resourceGroup ? `rg ${f.resourceGroup}` : f.count != null ? `${fmt.int(f.count)} assignments` : "";
  const row = [kindBadge(f.kind), nameCell(f, ranAt, sec)];
  if (hasSubs) row.push(subCell(f));
  if (hasExpiry) row.push(expiryCell(f));
  row.push(`${pathChain(f)}<span class="detail-cell">${esc(f.detail || "")}</span>${ruleLink(f)}${controlTags(f)}`, `<span class="muted" title="${esc(f.firstSeen || "")}">${esc(fmt.date(f.firstSeen))}</span>`);
  row.push(acceptButton(f));
  return row;
}
function genericBody(shown, t) {
  const hasSubs = shown.some((f) => f.subscriptionId);
  const hasExpiry = shown.some((f) => f.expires || f.kind === "kv-no-expiry");
  const slice = shown.slice(0, t.shown);
  return tableHtml(genericColumns(t.data.ranAt, hasSubs, hasExpiry), slice.map((f) => genericRow(f, t.data.ranAt, hasSubs, hasExpiry))) + moreButton(slice.length, shown.length, t);
}
const GENERIC = { stats: genericStats, body: genericBody };

/* Orphaned resources: what the leftovers cost a month at list price, most expensive first. */
function orCosts(list) {
  const by = {};
  for (const f of list) if (f.monthlyCost > 0) by[f.currency || ""] = (by[f.currency || ""] || 0) + f.monthlyCost;
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}
// What cleaning up has saved: resources that were found and are now deleted (from /api/orphaned-resources/savings,
// kept by the scan). Loaded once per run.
const MONTH_MS = 30.44 * 86400000;
function orSavings(t) {
  if (t.savings && t.savings.ranAt === t.data.ranAt) return t.savings;
  if (!t.savingsLoading) {
    const ranAt = t.data.ranAt;
    t.savingsLoading = apiJson("/api/orphaned-resources/savings")
      .then((data) => (t.savings = { ranAt, data }))
      .catch((err) => (t.savings = { ranAt, error: err.message }))
      .finally(() => {
        t.savingsLoading = null;
        if (state.route === "scan/orphaned-resources") renderFindings("orphaned-resources");
        else if (state.route === "overview") renderOverview();
        else if (state.route === "report") Report.redraw();
      });
  }
  return null;
}
// What was done to a cleaned-up resource, in words.
const SAVING_ACTIONS = {
  "unattached-disk": "Deleted an unattached disk",
  "unused-public-ip": "Deleted an unused public IP",
  "orphaned-snapshot": "Deleted an orphaned snapshot",
  "old-snapshot": "Deleted an old snapshot",
  "empty-app-service-plan": "Deleted an empty App Service plan",
  "stopped-vm": "Deallocated or deleted a stopped VM",
  "idle-nat-gateway": "Deleted an idle NAT gateway",
  "empty-load-balancer": "Deleted an empty load balancer",
  "idle-app-gateway": "Deleted an idle application gateway",
  "idle-vnet-gateway": "Deleted an idle gateway",
  "disconnected-private-endpoint": "Deleted a disconnected private endpoint",
  "unlinked-private-dns-zone": "Deleted an unlinked private DNS zone",
  "backup-vm-deleted": "Deleted the backup of a deleted VM",
};
const savingAction = (e) => SAVING_ACTIONS[e.kind] || `Cleaned up: ${kindLabel(e.kind)}`;
// [[currency, a month, saved so far]], biggest first
function orSaved(entries) {
  const by = {};
  for (const e of entries) {
    const c = e.currency || "USD";
    const x = (by[c] = by[c] || [0, 0]);
    x[0] += e.monthlyCost || 0;
    x[1] += (e.monthlyCost || 0) * Math.max(0, (Date.now() - Date.parse(e.savedAt)) / MONTH_MS);
  }
  return Object.entries(by).map(([c, [m, so]]) => [c, m, so]).sort((a, b) => b[1] - a[1]);
}
const orView = (t) => (t.filters.view === "saved" ? "saved" : "findings");
function orStats(all, t) {
  // Advisor's tips are its own estimates (often in USD), shown apart from the leftovers' list prices
  const tips = orCosts(all.filter((f) => f.kind === "advisor-cost"));
  const costs = orCosts(all.filter((f) => f.kind !== "advisor-cost"));
  const unpriced = all.filter((f) => f.monthlyCost === null && f.kind !== "advisor-cost").length;
  const money = (pairs, k) => (pairs.length ? pairs.map(([c, v]) => fmt.money(v * k, c, true)).join(" + ") : "–");
  const sv = orSavings(t);
  const saved = sv && sv.data ? orSaved(sv.data.entries) : [];
  const savedTile = statTile({
    label: "Saved a month by cleanup",
    value: !sv ? "…" : saved.length ? saved.map(([c, m]) => fmt.money(m, c, true)).join(" + ") : "–",
    delta: saved.length ? `about ${saved.map(([c, , so]) => fmt.money(so, c, true)).join(" + ")} saved so far` : sv && sv.data && sv.data.since ? `counting since ${fmt.date(sv.data.since)}` : "deleted orphans count here",
    deltaCls: saved.length ? "good" : "",
  });
  return (
    statTile({ label: "Wasted a month", value: money(costs, 1), delta: unpriced ? `${fmt.int(unpriced)} without a price` : "Azure list price, before discounts", deltaCls: costs.length ? "bad" : "" }) +
    statTile({ label: "Wasted a year", value: money(costs, 12), delta: tips.length ? `Advisor tips: ${money(tips, 1)} a month more` : "if nothing is cleaned up" }) +
    savedTile +
    genericStats(all, t)
  );
}
function orExtra(all, t) {
  const v = orView(t);
  for (const sel of ["#scan-fw", "#scan-new", "#scan-csv"]) $(sel).classList.toggle("hidden", v !== "findings");
  const sv = orSavings(t);
  const n = sv && sv.data ? sv.data.entries.length : 0;
  return `<div class="seg"><button type="button" data-view="findings" class="${v === "findings" ? "active" : ""}">Findings <span class="n">${fmt.int(all.length)}</span></button><button type="button" data-view="saved" class="${v === "saved" ? "active" : ""}">Cleaned up <span class="n">${fmt.int(n)}</span></button></div>`;
}
function orPage(all, t) {
  if (orView(t) !== "saved") return null;
  const sv = orSavings(t);
  if (!sv) return `<div class="empty-state">Loading what has been cleaned up…</div>`;
  if (sv.error) return `<div class="empty-state">Could not load the savings: ${esc(sv.error)}</div>`;
  const q = t.filters.q;
  const list = sv.data.entries
    .filter((e) => (!t.filters.sub || e.subscriptionId === t.filters.sub) && (!q || [e.name, e.resourceGroup, e.subscriptionName, e.tenantName, (KINDS[e.kind] || [e.kind])[0]].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  if (!list.length) return `<div class="empty-state">${sv.data.entries.length ? "Nothing cleaned up matches these filters." : `Nothing counted yet. When an orphaned resource with a price is deleted, the next scan counts it here${sv.data.since ? ` (counting since ${esc(fmt.date(sv.data.since))})` : ""}.`}</div>`;
  const saved = orSaved(list);
  const rows = list.slice(0, t.shown).map((e) => {
    const months = Math.max(0, (Date.now() - Date.parse(e.savedAt)) / MONTH_MS);
    return [
      kindBadge(e.kind),
      nameCell(e),
      subCell(e),
      `<span class="num">${esc(fmt.money(e.monthlyCost, e.currency))}</span>`,
      `<span title="${esc(e.savedAt)}">${esc(fmt.date(e.savedAt))}</span>`,
      `<span class="num good">${esc(fmt.money(e.monthlyCost * months, e.currency))}</span>`,
    ];
  });
  return `<p class="muted small">Orphaned resources that were deleted after the dashboard found them (a stopped VM counts once it is deallocated). Each saves its monthly list price from the day it went (before discounts; a resource that was put back in use is not counted). ${saved.map(([c, m, so]) => `${esc(fmt.money(m, c))} a month, about ${esc(fmt.money(so, c))} so far`).join("; ")}.</p>` +
    tableHtml([{ label: "Kind" }, { label: "Resource" }, { label: "Subscription" }, { label: "A month", cls: "num nowrap" }, { label: "Cleaned up" }, { label: "Saved so far", cls: "num nowrap" }], rows) +
    moreButton(Math.min(list.length, t.shown), list.length, t);
}
function orBody(shown, t) {
  const sorted = shown.slice().sort((a, b) => (b.monthlyCost || 0) - (a.monthlyCost || 0));
  const hasSubs = sorted.some((f) => f.subscriptionId);
  const slice = sorted.slice(0, t.shown);
  const cols = genericColumns(t.data.ranAt, hasSubs, false);
  cols.splice(hasSubs ? 3 : 2, 0, { label: "A month", cls: "num nowrap" });
  const rows = slice.map((f) => {
    const row = genericRow(f, t.data.ranAt, hasSubs, false);
    row.splice(hasSubs ? 3 : 2, 0, f.monthlyCost == null ? (f.currency ? `<span class="muted">?</span>` : "") : f.monthlyCost === 0 ? `<span class="muted">0</span>` : esc(fmt.money(f.monthlyCost, f.currency)));
    return row;
  });
  return tableHtml(cols, rows) + moreButton(slice.length, sorted.length, t);
}

/* access review view */
function arStats(all, t) {
  const direct = all.filter((f) => f.principalType !== "Group");
  const groups = all.filter((f) => f.principalType === "Group");
  const viaGroups = new Set(groups.flatMap((g) => (g.members || []).filter((m) => m.type === "User").map((m) => m.id)));
  const oldest = all.reduce((max, f) => Math.max(max, f.ageDays || 0), 0);
  const owners = all.filter((f) => /^owner/i.test(f.role || "")).length;
  const missing = all.filter((f) => f.missing).length;
  const fresh = all.filter((f) => isNew(f, t.data.ranAt)).length;
  return (
    statTile({ label: "Direct user assignments", value: fmt.int(direct.length) }) +
    statTile({ label: "Group assignments", value: fmt.int(groups.length), delta: `${fmt.int(viaGroups.size)} people get access through them` }) +
    statTile({ label: "Owner role", value: fmt.int(owners), deltaCls: owners ? "bad" : "" }) +
    statTile({ label: "Principal not found", value: fmt.int(missing), deltaCls: missing ? "bad" : "", delta: missing ? "deleted in Entra, safe to remove" : "" }) +
    statTile({ label: "Oldest assignment", value: all.length ? `${Math.floor(oldest / 365)}y ${oldest % 365}d` : "–" }) +
    statTile({ label: "New this run", value: fmt.int(fresh), deltaCls: fresh ? "bad" : "" })
  );
}
function arExtra(all, t) {
  const roles = [...new Set(all.map((f) => f.role).filter(Boolean))].sort();
  return `
    <select class="select" data-filter="ptype">
      <option value=""${t.filters.ptype === "" ? " selected" : ""}>Direct and groups</option>
      <option value="User"${t.filters.ptype === "User" ? " selected" : ""}>Direct (users)</option>
      <option value="Group"${t.filters.ptype === "Group" ? " selected" : ""}>Groups</option>
    </select>
    <select class="select" data-filter="role">
      <option value="">All roles</option>
      ${roles.map((r) => `<option value="${esc(r)}"${t.filters.role === r ? " selected" : ""}>${esc(r)}</option>`).join("")}
    </select>`;
}
function arScope(f, t) {
  const type = t.filters.ptype;
  if (type && (type === "Group" ? f.principalType !== "Group" : f.principalType === "Group")) return false;
  if (t.filters.role && f.role !== t.filters.role) return false;
  return true;
}
function arMembers(f) {
  const members = Array.isArray(f.members) ? f.members : [];
  const glyph = (m) => (m.type === "Group" ? icon("users") : m.type === "App" ? icon("app") : icon("user"));
  const card = (m) =>
    `<div class="ar-member${m.enabled ? "" : " disabled"}" title="${esc(m.type || "")}${m.enabled ? "" : " (disabled)"}"><span class="m-ico">${glyph(m)}</span><div><div>${esc(m.name)}${m.enabled ? "" : ' <span class="muted">(disabled)</span>'}</div>${m.upn ? `<div class="secondary">${esc(m.upn)}</div>` : ""}</div></div>`;
  // Runs before 0.13.1.0 kept one flat list (no `via`).
  if (!members.some((m) => m.via)) {
    const total = f.memberTotal != null ? f.memberTotal : members.length;
    const more = total > members.length ? `<div class="note">+${fmt.int(total - members.length)} more not listed.</div>` : "";
    return `<div class="ar-members">${members.map(card).join("") || '<span class="muted">No members.</span>'}</div>${more}`;
  }
  const byGroup = new Map();
  for (const m of members) {
    if (!byGroup.has(m.via)) byGroup.set(m.via, []);
    byGroup.get(m.via).push(m);
  }
  // People reached through a group, nested ones included (each counted once).
  const reach = (id, path) => {
    const out = new Set();
    for (const m of byGroup.get(id) || []) {
      if (m.type !== "Group") out.add(m.id);
      else if (!path.includes(m.id)) for (const p of reach(m.id, [...path, m.id])) out.add(p);
    }
    return out;
  };
  const level = (id, path) => {
    const list = byGroup.get(id) || [];
    const people = list.filter((m) => m.type !== "Group");
    const groups = list.filter((m) => m.type === "Group");
    const nested = groups
      .map((g) => {
        if (path.includes(g.id)) return `<div class="ar-nested loop">${icon("users")} ${esc(g.name)} <span class="muted small">(contains a group above it, not opened again)</span></div>`;
        const n = reach(g.id, [...path, g.id]).size;
        return `<details class="ar-nested"><summary>${icon("users")} <b>${esc(g.name)}</b> <span class="muted small">nested group · ${fmt.int(n)} member${n === 1 ? "" : "s"}</span></summary>${level(g.id, [...path, g.id])}</details>`;
      })
      .join("");
    const cards = people.length ? `<div class="ar-members">${people.map(card).join("")}</div>` : "";
    return cards + nested || '<span class="muted">No members.</span>';
  };
  const note = [
    f.nestedGroups ? `${fmt.int(f.memberTotal)} unique member${f.memberTotal === 1 ? "" : "s"}, ${fmt.int(f.nestedGroups)} nested group${f.nestedGroups === 1 ? "" : "s"}. Open a nested group to see who is in it.` : "",
    f.membersTruncated ? "List cut short (very large group); some members are not shown." : "",
  ].filter(Boolean);
  return level(f.principalId, [f.principalId]) + note.map((n) => `<div class="note">${esc(n)}</div>`).join("");
}
function arBody(shown, t) {
  const ranAt = t.data.ranAt;
  const slice = shown.slice(0, t.shown);
  const rows = slice.map((f) => {
    const isGroup = f.principalType === "Group";
    const total = f.memberTotal != null ? f.memberTotal : null;
    const key = String(f.id || "");
    const who = `<div class="ar-who"><span class="ar-ico${isGroup ? " group" : ""}">${icon(isGroup ? "users" : "user")}</span><div class="name-cell"><div class="primary">${esc(f.name || f.principalId || "")}${isNew(f, ranAt) ? '<span class="new-badge">NEW</span>' : ""}</div>${f.upn ? `<div class="secondary">${esc(f.upn)}</div>` : ""}${f.missing ? `<div class="secondary bad">not found in Entra (deleted?) · ${esc(f.principalId || "")}</div>` : ""}</div></div>`;
    const where = `<div class="sub-cell"><div class="primary">${esc(f.subscriptionName || f.subscriptionId || "Tenant")}</div><div class="secondary" style="font-family:inherit">${esc(f.scopeLevel || "")}${f.scopeTarget && f.scopeLevel !== "Subscription" ? " · " + esc(f.scopeTarget) : ""}</div></div>`;
    const assigned = `<div>${esc(f.createdOn ? fmt.date(f.createdOn) : "")}</div><div class="secondary">${f.ageDays != null ? `${fmt.int(f.ageDays)} days ago` : ""}</div>`;
    const toggle = isGroup
      ? total == null
        ? `<span class="muted small">members unknown</span>`
        : `<button type="button" class="chip${t.open.has(key) ? " active" : ""}" data-toggle="${esc(key)}">${icon("chevron")} ${fmt.int(total)} member${total === 1 ? "" : "s"}</button>`
      : "";
    const main = `<tr>${[who, roleBadge(f.role), where, assigned, `<div class="ar-actions">${toggle}${acceptButton(f)}</div>`].map((c) => `<td>${c}</td>`).join("")}</tr>`;
    const members = isGroup && total != null ? `<tr class="ar-members-row${t.open.has(key) ? "" : " hidden"}" data-members="${esc(key)}"><td colspan="5">${arMembers(f)}</td></tr>` : "";
    return main + members;
  });
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Who</th><th>Role</th><th>Where</th><th>Assigned</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` + moreButton(slice.length, shown.length, t);
}

/* policy check view */
const isProbe = (f) => String(f.kind || "").startsWith("probe-");
// Probe call or check failures (scan-error findings named after the probes).
const pcProbeErrors = (all) => all.filter((f) => f.kind === "scan-error" && /\/scan-errors\/(probe-calls|Probes)$/.test(f.id || ""));
// With no probe findings, the page opens on Assignment health until a view is picked.
const pcView = (t) => (["assignments", "recommended"].includes(t.filters.view) ? t.filters.view : t.filters.view === "health" || (!t.viewPicked && t.pcNoProbes) ? "health" : "probes");
function pcStats(all, t) {
  const probes = all.filter(isProbe);
  const open = probes.filter((f) => f.kind === "probe-not-blocked");
  const audit = probes.filter((f) => f.kind === "probe-only-audited");
  const health = all.filter((f) => !isProbe(f) && f.kind !== "scan-error");
  const subs = new Set(open.map((f) => f.subscriptionId).filter(Boolean)).size;
  const fresh = all.filter((f) => isNew(f, t.data.ranAt)).length;
  const failed = pcProbeErrors(all).length > 0;
  t.pcNoProbes = !probes.length && health.length > 0;
  const probeDelta = open.length ? `in ${fmt.int(subs)} subscription${subs === 1 ? "" : "s"}` : failed ? "probes failed; see the errors above" : "every probe was denied";
  return (
    statTile({ label: "Probes not blocked", value: fmt.int(open.length), deltaCls: open.length || failed ? "bad" : "good", delta: probeDelta }) +
    statTile({ label: "Only audited", value: fmt.int(audit.length), deltaCls: audit.length ? "" : "", delta: "allowed, but logged" }) +
    statTile({ label: "Assignment health issues", value: fmt.int(health.length), deltaCls: health.length ? "bad" : "" }) +
    statTile({ label: "New this run", value: fmt.int(fresh), deltaCls: fresh ? "bad" : "" })
  );
}
function pcExtra(all, t) {
  const nProbes = all.filter(isProbe).length;
  const nHealth = all.filter((f) => !isProbe(f) && f.kind !== "scan-error").length;
  const v = pcView(t);
  for (const sel of ["#scan-fw", "#scan-new"]) $(sel).classList.toggle("hidden", v === "assignments" || v === "recommended");
  $("#scan-q").placeholder = v === "assignments" ? "Search assignment, parameter, policy inside" : v === "recommended" ? "Search policy, probe" : "Search name, detail, subscription";
  const todo = PolicyAssignments.todoCount(t);
  return `<div class="seg"><button type="button" data-view="probes" class="${v === "probes" ? "active" : ""}">Probes <span class="n">${fmt.int(nProbes)}</span></button><button type="button" data-view="health" class="${v === "health" ? "active" : ""}">Assignment health <span class="n">${fmt.int(nHealth)}</span></button><button type="button" data-view="assignments" class="${v === "assignments" ? "active" : ""}">Assignments</button><button type="button" data-view="recommended" class="${v === "recommended" ? "active" : ""}">Recommended${todo ? ` <span class="n">${fmt.int(todo)}</span>` : ""}</button></div>${v === "assignments" ? PolicyAssignments.extra(t) : ""}`;
}
const pcScope = (f, t) => (pcView(t) === "assignments" || pcView(t) === "recommended" ? true : pcView(t) === "health" ? !isProbe(f) : isProbe(f));
// Probes view with no probe findings at all: say why, not "no findings match".
function pcEmptyProbes(all, t) {
  if (pcView(t) === "assignments") return PolicyAssignments.page(t);
  if (pcView(t) === "recommended") return PolicyAssignments.recommended(t);
  if (pcView(t) !== "probes" || all.some(isProbe)) return null;
  return pcProbeErrors(all).length
    ? `<div class="empty-state">The probes could not run this time (see the errors above), so no subscription is listed.</div>`
    : `<div class="empty-state">Every probe was blocked by policy in every subscription.</div>`;
}
function pcMatrix(shown, t) {
  const ranAt = t.data.ranAt;
  const subs = new Map();
  const probesSeen = new Set();
  for (const f of shown) {
    const key = f.subscriptionId || "";
    if (!subs.has(key)) subs.set(key, { id: key, name: f.subscriptionName || f.subscriptionId || "Tenant", cells: {} });
    subs.get(key).cells[f.probe] = f;
    probesSeen.add(f.probe);
  }
  const probes = PROBE_ORDER.filter((p) => probesSeen.has(p)).concat([...probesSeen].filter((p) => !PROBE_ORDER.includes(p)).sort());
  const rows = [...subs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const cell = (f) => {
    if (!f) return `<span class="verdict ok">blocked</span>`;
    const dot = isNew(f, ranAt) ? '<span class="nd" title="New this run"></span>' : "";
    // A runner can click a verdict to accept it (e.g. public IPs are allowed in that subscription).
    const acc = f.key && canRunFor(f) ? ` data-accept="${esc(f.key)}" role="button" tabindex="0"` : "";
    const tip = esc((f.detail || "") + (f.recommend ? ` · Fix: ${f.recommend}` : "") + (acc ? " · Click to accept" : ""));
    return f.kind === "probe-not-blocked"
      ? `<span class="verdict open${acc ? " clickable" : ""}" title="${tip}"${acc}>${dot}Open</span>`
      : `<span class="verdict audit${acc ? " clickable" : ""}" title="${tip}"${acc}>${dot}Audit</span>`;
  };
  return `
    <div class="matrix-wrap"><table class="matrix">
      <thead><tr><th>Subscription</th>${probes.map((p) => `<th title="${esc(p)}">${esc(PROBE_SHORT[p] || fmt.humanize(p))}</th>`).join("")}</tr></thead>
      <tbody>${rows
        .map((r) => `<tr><td><div class="sub-cell"><div class="primary">${esc(r.name)}</div>${r.id && r.name !== r.id ? `<div class="secondary">${esc(r.id)}</div>` : ""}</div></td>${probes.map((p) => `<td class="cell">${cell(r.cells[p])}</td>`).join("")}</tr>`)
        .join("")}</tbody>
    </table></div>
    <div class="matrix-legend">
      <span><span class="verdict open">Open</span> the resource would be created</span>
      <span><span class="verdict audit">Audit</span> allowed, only logged</span>
      <span><span class="verdict ok">blocked</span> denied by policy</span>
      <span><span class="verdict open"><span class="nd"></span></span> new this run</span>
    </div>
    <div class="note">Subscriptions where every probe was blocked (or whose open probes were all accepted) are not listed. Hover a verdict for the policy detail and the fix; click it to accept it. The Recommended tab lists the built-in policies to assign.</div>`;
}
function pcHealth(shown, t) {
  const ranAt = t.data.ranAt;
  const groups = new Map();
  for (const f of shown) {
    if (!groups.has(f.kind)) groups.set(f.kind, []);
    groups.get(f.kind).push(f);
  }
  const order = [...groups.keys()].sort((a, b) => (kindSev(b) === "crit") - (kindSev(a) === "crit") || groups.get(b).length - groups.get(a).length);
  let n = 0;
  let html = "";
  for (const kind of order) {
    const list = groups.get(kind);
    html += `<tr class="kind-group-head"><td colspan="5">${kindBadge(kind)} <span class="muted">${fmt.int(list.length)}</span></td></tr>`;
    for (const f of list) {
      if (n++ >= t.shown) break;
      const roles = Array.isArray(f.missingRoles) && f.missingRoles.length ? `<div class="inline-list" style="margin-top:4px">${f.missingRoles.map((r) => `<span class="tag">${esc(r)}</span>`).join("")}</div>` : "";
      // Details: the assignment's parameters, policies and effects (policyAssignments.js).
      const key = `pa:${f.id}`;
      const open = t.open.has(key);
      const details = PolicyAssignments.hasDetail(f) ? `<button type="button" class="chip${open ? " active" : ""}" data-toggle="${esc(key)}">${icon("chevron")} Details</button>` : "";
      html += `<tr><td>${nameCell(f, ranAt, f.scopeText || shortScope(f.scope) || (f.resourceGroup ? "rg " + f.resourceGroup : ""))}</td><td>${subCell(f)}</td><td><span class="detail-cell">${esc(f.detail || "")}</span>${roles}${controlTags(f)}</td><td class="nowrap"><span class="muted">${esc(fmt.date(f.firstSeen))}</span></td><td><div class="ar-actions">${details}${acceptButton(f)}</div></td></tr>`;
      if (open && details) html += `<tr class="ar-members-row" data-members="${esc(key)}"><td colspan="5">${PolicyAssignments.detailFor(f, t)}</td></tr>`;
    }
    if (n >= t.shown) break;
  }
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Assignment</th><th>Subscription</th><th>Detail</th><th>First seen</th><th></th></tr></thead><tbody>${html}</tbody></table></div>` + moreButton(Math.min(n, t.shown), shown.length, t);
}
/* key vault view */
const KV_AREAS = [
  ["all", "All"],
  ["settings", "Settings"],
  ["expiry", "Expiry"],
  ["access", "Access"],
  ["logging", "Logging"],
];
const kvArea = (t) => (KV_AREAS.some(([a]) => a === t.filters.view) ? t.filters.view : "all");
function kvStats(all, t) {
  const vaults = new Set(all.map((f) => f.vault).filter(Boolean)).size;
  const n = (k) => all.filter((f) => f.kind === k).length;
  const expired = n("kv-expired");
  const expiring = n("kv-expiring");
  const access = all.filter((f) => f.area === "access").length;
  const unchecked = n("kv-no-data-access");
  const fresh = all.filter((f) => isNew(f, t.data.ranAt)).length;
  return (
    statTile({ label: "Vaults with findings", value: fmt.int(vaults) }) +
    statTile({ label: "Expired", value: fmt.int(expired), deltaCls: expired ? "bad" : "good", delta: expired ? "secrets, keys or certs" : "nothing expired" }) +
    statTile({ label: "Expiring soon", value: fmt.int(expiring), deltaCls: expiring ? "bad" : "" }) +
    statTile({ label: "Access issues", value: fmt.int(access), deltaCls: access ? "bad" : "" }) +
    statTile({ label: "Vaults not checked", value: fmt.int(unchecked), delta: unchecked ? "no permission or firewall" : "" }) +
    statTile({ label: "New this run", value: fmt.int(fresh), deltaCls: fresh ? "bad" : "" })
  );
}
function kvExtra(all, t) {
  const v = kvArea(t);
  return `<div class="seg">${KV_AREAS.map(([a, label]) => `<button type="button" data-view="${a}" class="${v === a ? "active" : ""}">${label} <span class="n">${fmt.int(a === "all" ? all.length : all.filter((f) => f.area === a).length)}</span></button>`).join("")}</div>`;
}
const kvScope = (f, t) => kvArea(t) === "all" || f.area === kvArea(t);
function kvBody(shown, t) {
  // Expiry view: soonest (most overdue) first.
  if (kvArea(t) === "expiry") shown = [...shown].sort((a, b) => (a.expires ? Date.parse(a.expires) : Infinity) - (b.expires ? Date.parse(b.expires) : Infinity));
  return genericBody(shown, t);
}

/* Resilience and Resource settings: one tab per service area found, so a long list stays readable. */
function areaOf(t) {
  const all = t.data.findings;
  if (!t.areas || t.areas.src !== all) t.areas = { src: all, set: new Set(all.map((f) => f.area).filter(Boolean)) };
  return t.areas.set.has(t.filters.view) ? t.filters.view : "all";
}
function areaExtra(all, t) {
  const v = areaOf(t);
  const counts = {};
  for (const f of all) if (f.area) counts[f.area] = (counts[f.area] || 0) + 1;
  const tabs = [["all", "All", all.length], ...Object.keys(counts).sort().map((a) => [a, a, counts[a]])];
  return tabs.length > 2 ? `<div class="seg">${tabs.map(([a, label, n]) => `<button type="button" data-view="${esc(a)}" class="${v === a ? "active" : ""}">${esc(label)} <span class="n">${fmt.int(n)}</span></button>`).join("")}</div>` : "";
}
function areaStats(all, t) {
  const crit = all.filter((f) => kindSev(f.kind) === "crit").length;
  const resources = new Set(all.map((f) => String(f.id || "").split("#")[0])).size;
  const fresh = all.filter((f) => isNew(f, t.data.ranAt)).length;
  const areas = new Set(all.map((f) => f.area).filter(Boolean)).size;
  return (
    statTile({ label: "Open findings", value: fmt.int(all.length) }) +
    statTile({ label: "Critical", value: fmt.int(crit), deltaCls: crit ? "bad" : "good", delta: crit ? "fix these first" : "none" }) +
    statTile({ label: "Resources affected", value: fmt.int(resources) }) +
    statTile({ label: "Service areas", value: fmt.int(areas) }) +
    statTile({ label: "New this run", value: fmt.int(fresh), deltaCls: fresh ? "bad" : "", delta: fresh ? "first seen in the last run" : "nothing new" })
  );
}
// Critical first, then by kind, so each tab reads as a short list per problem.
const SEV_ORDER = { crit: 0, warn: 1, info: 2, "": 3 };
const areaBody = (shown, t) => genericBody([...shown].sort((a, b) => (SEV_ORDER[kindSev(a.kind)] ?? 3) - (SEV_ORDER[kindSev(b.kind)] ?? 3) || a.kind.localeCompare(b.kind)), t);
const AREA_VIEW = {
  stats: areaStats,
  extra: areaExtra,
  scope: (f, t) => areaOf(t) === "all" || f.area === t.filters.view,
  showKinds: (t) => areaOf(t) !== "all",
  body: areaBody,
};

/* licence coverage view: one tile per licence, users / licences owned */
const LC_SHORT = { p1: "Entra ID P1", p2: "Entra ID P2", gov: "ID Governance" };
function lcStats(all, t) {
  const tiers = all.filter((f) => f.tier && (f.kind === "licence-short" || f.kind === "licence-count"));
  if (!tiers.length) return genericStats(all, t);
  return tiers
    .map((f) => {
      const diff = f.owned - f.need;
      return statTile({
        label: `${multiView() && f.tenantName ? f.tenantName + " · " : ""}${LC_SHORT[f.tier] || f.name}: users / licences`,
        value: `${fmt.int(f.need)} / ${fmt.int(f.owned)}`,
        deltaCls: diff < 0 ? "bad" : "good",
        delta: diff < 0 ? `${fmt.int(-diff)} short` : `${fmt.int(diff)} spare`,
        sub: f.guests ? `+ ${fmt.int(f.guests)} guest${f.guests === 1 ? "" : "s"} (billed per active user)` : "",
      });
    })
    .join("");
}

/* Exposure paths: routes from the internet to what matters, and a subnet-to-subnet map of each VNet. */
function pathChain(f) {
  if (!Array.isArray(f.path) || !f.path.length) return "";
  const steps = f.path.map((s) => `<span class="path-step ps-${esc(s.t)}" title="${esc(s.note || "")}">${s.note ? `<span class="ps-label">${esc(s.label)}</span><span class="ps-note">${esc(s.note)}</span>` : `<span class="ps-label">${esc(s.label)}</span>`}</span>`);
  // The arrow stays with the step after it, so a wrapped chain never ends a line on an arrow.
  return `<div class="path-chain">${steps.map((h, i) => (i ? `<span class="path-link"><span class="path-arrow" aria-hidden="true">→</span>${h}</span>` : h)).join("")}</div>`;
}
const epView = (t) => (t.filters.view === "maps" ? "maps" : "paths");
function epExtra(all, t) {
  const v = epView(t);
  const paths = all.filter((f) => f.kind.startsWith("path-")).length;
  const maps = all.filter((f) => f.kind.startsWith("seg-")).length;
  return `<div class="seg"><button type="button" data-view="paths" class="${v === "paths" ? "active" : ""}">Attack paths <span class="n">${fmt.int(paths)}</span></button><button type="button" data-view="maps" class="${v === "maps" ? "active" : ""}">Subnet maps <span class="n">${fmt.int(maps)}</span></button></div>`;
}
function epStats(all, t) {
  const paths = all.filter((f) => f.kind.startsWith("path-"));
  const crit = paths.filter((f) => kindSev(f.kind) === "crit").length;
  const entries = new Set(paths.map((f) => String(f.id).split("#")[0])).size;
  const targets = new Set(paths.flatMap((f) => f.targets || [])).size;
  const flat = all.filter((f) => f.kind === "seg-flat-vnet").length;
  return (
    statTile({ label: "Attack paths", value: fmt.int(paths.length) }) +
    statTile({ label: "Critical", value: fmt.int(crit), deltaCls: crit ? "bad" : "good", delta: crit ? "fix these first" : "none" }) +
    statTile({ label: "Entry points on a path", value: fmt.int(entries), sub: "reachable from the internet" }) +
    statTile({ label: "Sensitive resources reached", value: fmt.int(targets) }) +
    statTile({ label: "Flat VNets", value: fmt.int(flat), deltaCls: flat ? "bad" : "good", delta: flat ? "most subnets reach each other" : "segmented" })
  );
}
function epMap(f, t) {
  const m = f.matrix;
  const head = m.subnets.map((s) => `<th class="sm-col" title="${esc(`${s.name} ${s.prefix}`)}"><span>${esc(s.name)}</span></th>`).join("");
  const rows = m.subnets.map((s, i) => {
    const tags = `${s.internet ? '<span class="sm-tag sm-net" title="Reachable from the internet">internet</span>' : ""}${s.data ? '<span class="sm-tag sm-data" title="Holds sensitive data">data</span>' : ""}`;
    const cells = m.cells[i].map((c, j) => {
      if (!c) return '<td class="sm-cell sm-self"></td>';
      const title = `${s.name} → ${m.subnets[j].name}: ${c.n}`;
      const text = c.v === "admin" ? "admin" : c.v === "data" ? "data" : "";
      return `<td class="sm-cell sm-${c.v || "closed"}" title="${esc(title)}">${text}</td>`;
    });
    return `<tr><th class="sm-row"><span class="sm-name">${esc(s.name)}</span><span class="sm-sub">${esc(s.prefix)}${s.nsg ? ` · ${esc(s.nsg)}` : ' · <b class="sm-nonsg">no NSG</b>'}</span>${tags}</th>${cells.join("")}</tr>`;
  });
  return `<div class="card sm-card"><div class="card-head"><h3>${esc(f.name)}</h3><span class="muted">${kindBadge(f.kind)} ${f.resourceGroup ? `rg ${esc(f.resourceGroup)}` : ""}</span></div>
    <p class="sm-detail">${esc(f.detail)}${controlTags(f)}</p>
    <div class="sm-wrap"><table class="sm-table"><thead><tr><th class="sm-corner">from ↓ · to →</th>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
}
const SM_LEGEND = '<div class="sm-legend"><span><i class="sm-cell sm-admin"></i>admin ports open (SSH, RDP, WinRM)</span><span><i class="sm-cell sm-data"></i>only data ports open</span><span><i class="sm-cell sm-closed"></i>blocked</span><span class="muted">From the NSG rules and routes; hover a cell for the rule that decides it.</span></div>';
function epBody(shown, t) {
  if (epView(t) === "maps") {
    const maps = shown.filter((f) => f.matrix).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "seg-flat-vnet" ? -1 : 1));
    return maps.length ? SM_LEGEND + maps.map((f) => epMap(f, t)).join("") : '<p class="muted">No VNet with two or more subnets.</p>';
  }
  return epPaths(shown, t);
}
// Attack paths, one card per internet entry point: what is open on it once at
// the top, then each path as a short route (the steps after the entry, one per
// line with the reason beside it), the fix, and the full list in a fold.
const SEV_RANK = { crit: 0, warn: 1, "": 2 };
const epEntryId = (f) => String(f.id).split("#")[0];
function epRoute(f) {
  const steps = (Array.isArray(f.path) ? f.path : []).filter((s) => !["internet", "entry"].includes(s.t));
  // The entry itself opens the route; the internet and the public address are in the card head.
  return `<ol class="ep-route">${steps.map((s) => `<li class="ep-step ps-${esc(s.t)}"><span class="ep-step-label">${esc(s.label)}</span>${s.note ? `<span class="ep-step-note">${esc(s.note)}</span>` : ""}</li>`).join("")}</ol>`;
}
function epPathItem(f, ranAt) {
  const reached = Array.isArray(f.reached) ? f.reached : [];
  return `<li class="ep-path">
      <div class="ep-path-top">${kindBadge(f.kind)}${isNew(f, ranAt) ? '<span class="new-badge">NEW</span>' : ""}<span class="ep-spacer"></span>${controlTags(f)}${acceptButton(f)}</div>
      ${epRoute(f)}
      ${f.risk ? `<div class="ep-risk">${esc(f.risk)}.</div>` : ""}
      ${f.fix ? `<div class="ep-fix"><b>Fix:</b> ${esc(f.fix)}.</div>` : ""}
      <details class="ep-more"><summary>${reached.length > 1 ? `All ${fmt.int(reached.length)} reached` : "Details"}</summary>${reached.length ? `<ul>${reached.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}<p>${esc(f.detail || "")}</p></details>
    </li>`;
}
function epPaths(shown, t) {
  const paths = shown.filter((f) => f.kind.startsWith("path-"));
  if (!paths.length) return '<p class="muted">No attack paths. Nothing reachable from the internet leads to sensitive data or to a role that can take over a subscription.</p>';
  const byEntry = new Map();
  for (const f of paths) {
    const k = epEntryId(f);
    if (!byEntry.has(k)) byEntry.set(k, []);
    byEntry.get(k).push(f);
  }
  const worst = (list) => Math.min(...list.map((f) => SEV_RANK[kindSev(f.kind)] ?? 2));
  const groups = [...byEntry.values()]
    .map((list) => list.sort((a, b) => (SEV_RANK[kindSev(a.kind)] ?? 2) - (SEV_RANK[kindSev(b.kind)] ?? 2)))
    .sort((a, b) => worst(a) - worst(b) || b.length - a.length || String(a[0].name).localeCompare(String(b[0].name)));
  return groups
    .map((list) => {
      const f = list[0];
      const open = Array.isArray(f.open) ? f.open : [];
      const where = [f.entry, f.resourceGroup ? `rg ${f.resourceGroup}` : "", f.subscriptionName || "", multiView() && f.tenantName ? f.tenantName : ""].filter(Boolean).join(" · ");
      const crit = list.filter((x) => kindSev(x.kind) === "crit").length;
      return `<div class="ep-card${crit ? " ep-crit" : ""}">
        <div class="ep-head">
          <div class="ep-who"><div class="ep-name">${esc(f.name)}</div><div class="ep-where">${esc(where)}</div></div>
          <div class="ep-count">${fmt.int(list.length)} path${list.length === 1 ? "" : "s"}${crit ? ` · <span class="bad">${fmt.int(crit)} critical</span>` : ""}</div>
        </div>
        <div class="ep-open"><span class="ep-open-label">Open to the internet</span>${open.map((w) => `<span class="ep-way" title="${esc(w.note)}"><b>${esc(w.via)}</b> ${esc(w.ports)}</span>`).join("")}</div>
        <ul class="ep-paths">${list.map((x) => epPathItem(x, t.data.ranAt)).join("")}</ul>
      </div>`;
    })
    .join("");
}
const EP_VIEW = {
  stats: epStats,
  extra: epExtra,
  scope: (f, t) => (epView(t) === "maps" ? f.kind.startsWith("seg-") : f.kind.startsWith("path-")),
  showKinds: (t) => epView(t) === "paths",
  body: epBody,
};

const VIEWS = {
  "orphaned-resources": { stats: orStats, extra: orExtra, page: orPage, showKinds: (t) => orView(t) === "findings", body: orBody },
  "licence-coverage": { stats: lcStats, body: genericBody },
  "key-vault": { stats: kvStats, extra: kvExtra, scope: kvScope, body: kvBody },
  resilience: AREA_VIEW,
  "resource-settings": AREA_VIEW,
  "exposure-paths": EP_VIEW,
  "access-review": { stats: arStats, extra: arExtra, scope: arScope, body: arBody },
  "policy-check": { stats: pcStats, extra: pcExtra, scope: pcScope, showKinds: (t) => pcView(t) === "health", page: pcEmptyProbes, body: (shown, t) => (pcView(t) === "health" ? pcHealth(shown, t) : pcMatrix(shown, t)) },
};

/* history */
function renderHistory(id) {
  const t = toolState(id);
  const h = t.history;
  const chartEl = $("#scan-chart");
  if (!chartEl) return;
  // A drawing has no findings to count over time.
  const card = $("#scan-hist-card");
  if (card) card.classList.toggle("hidden", !!TOOL_BY_ID[id].drawing);
  if (TOOL_BY_ID[id].drawing) return;
  $("#scan-hist-meta").textContent = h.length ? `${fmt.int(h.length)} run${h.length === 1 ? "" : "s"} kept · since ${fmt.date(h[0].ranAt)}` : "";
  if (!h.length) {
    Charts.columns(chartEl, { data: [], emptyText: t.loaded ? "No runs yet" : "Loading…" });
    $("#scan-chart-note").innerHTML = "";
    $("#scan-runs").innerHTML = `<div class="empty-state">${t.loaded ? "No runs recorded yet." : "Loading…"}</div>`;
    $("#scan-run-detail").innerHTML = "";
    return;
  }
  if (!t.selectedRun || !h.some((r) => r.ranAt === t.selectedRun)) t.selectedRun = h[h.length - 1].ranAt;
  const recent = h.slice(-40);
  const selIdx = recent.findIndex((r) => r.ranAt === t.selectedRun);
  Charts.columns(chartEl, {
    data: recent.map((r) => ({ label: fmt.dateShort(r.ranAt), value: r.count, ranAt: r.ranAt, added: r.added, resolved: r.resolved })),
    integer: true,
    selected: selIdx,
    valueLabel: "Findings",
    tooltip: (d) => ({ title: fmt.dateTime(d.ranAt), rows: [{ label: "Findings", value: fmt.int(d.value) }, { label: "New", value: "+" + fmt.int(d.added) }, { label: "Resolved", value: "−" + fmt.int(d.resolved) }], note: "Click to inspect this run" }),
    onSelect: (i, d) => selectRun(id, d.ranAt),
    emptyText: "No runs yet",
  });
  $("#scan-chart-note").innerHTML = `<span>Findings per run${h.length > 40 ? `, last 40 of ${fmt.int(h.length)}` : ""}</span><span>Click a bar or a row to see what changed</span>`;
  const rows = h
    .slice()
    .reverse()
    .map((r) => ({
      attrs: `class="clickable${r.ranAt === t.selectedRun ? " sel" : ""}" data-ranat="${esc(r.ranAt)}"`,
      cells: [
        `<span title="${esc(r.ranAt)}">${esc(fmt.dateTime(r.ranAt))}</span>`,
        fmt.int(r.count),
        `<span class="${r.added ? "delta-up" : "muted"}">+${fmt.int(r.added)}</span>`,
        `<span class="${r.resolved ? "delta-down" : "muted"}">−${fmt.int(r.resolved)}</span>`,
      ],
    }));
  $("#scan-runs").innerHTML = tableHtml([{ label: "Run" }, { label: "Findings", cls: "num" }, { label: "New", cls: "num" }, { label: "Resolved", cls: "num" }], rows);
  renderRunDetail(id);
}
function selectRun(id, ranAt) {
  toolState(id).selectedRun = ranAt;
  renderHistory(id);
}
function runDetailTable(list, ranAt) {
  const hasSubs = list.some((f) => f.subscriptionId);
  const slice = list.slice(0, 50);
  const cols = [{ label: "Kind" }, { label: "Name" }];
  if (hasSubs) cols.push({ label: "Subscription" });
  cols.push({ label: "Detail" });
  const rows = slice.map((f) => {
    const r = [kindBadge(f.kind), nameCell(f, null, f.upn || (f.resourceGroup ? "rg " + f.resourceGroup : ""))];
    if (hasSubs) r.push(subCell(f));
    r.push(`<span class="detail-cell">${esc(f.detail || "")}</span>`);
    return r;
  });
  return tableHtml(cols, rows, { scroll: true }) + (list.length > 50 ? `<div class="note">Showing 50 of ${fmt.int(list.length)}.</div>` : "");
}
function renderRunDetail(id) {
  const t = toolState(id);
  const ranAt = t.selectedRun;
  const el = $("#scan-run-detail");
  if (!el) return;
  if (!ranAt) {
    el.innerHTML = "";
    return;
  }
  const entry = t.history.find((r) => r.ranAt === ranAt) || {};
  const snap = t.snapshots[ranAt];
  const byKind = Object.entries(entry.byKind || {}).sort((a, b) => b[1] - a[1]);
  const head = `<h4>Run ${esc(fmt.dateTime(ranAt))} <span class="n">${fmt.int(entry.count || 0)} findings · +${fmt.int(entry.added || 0)} new · −${fmt.int(entry.resolved || 0)} resolved${ranAt === t.data.ranAt ? " · latest" : ""}</span></h4>` +
    (byKind.length ? `<div class="inline-list">${byKind.map(([k, n]) => `<span class="tag">${esc(kindLabel(k))} <b>${fmt.int(n)}</b></span>`).join("")}</div>` : "");
  let body;
  if (!snap) body = `<div class="empty-state">Loading what changed…</div>`;
  else if (snap.error) body = `<div class="status-msg error">${esc(snap.error)}</div>`;
  else {
    const added = Array.isArray(snap.added) ? snap.added : [];
    const resolved = Array.isArray(snap.resolved) ? snap.resolved : [];
    body = "";
    if (!snap.previousRanAt) body += `<div class="note">First recorded run: every finding counted as new.</div>`;
    if (added.length) body += `<h4><span class="delta-up">Added</span> <span class="n">${fmt.int(added.length)}</span></h4>${runDetailTable(added, ranAt)}`;
    if (resolved.length) body += `<h4><span class="delta-down">Resolved</span> <span class="n">${fmt.int(resolved.length)}</span></h4>${runDetailTable(resolved, ranAt)}`;
    if (!added.length && !resolved.length) body += `<div class="empty-state">Nothing changed in this run compared with the one before.</div>`;
  }
  el.innerHTML = head + body;
  if (!snap) {
    apiJson(`/api/tools/${id}/history/${encodeURIComponent(ranAt)}`)
      .then((s) => {
        t.snapshots[ranAt] = s;
      })
      .catch((err) => {
        t.snapshots[ranAt] = { error: err.message };
      })
      .then(() => {
        if (state.route === `scan/${id}` && t.selectedRun === ranAt) renderRunDetail(id);
      });
  }
}

/* run loop */
async function runTool(id) {
  const t = toolState(id);
  if (t.running) return;
  t.running = true;
  t.runError = null;
  t.runStarted = Date.now();
  t.runFinished = null;
  const prevRanAt = t.data.ranAt;
  renderRunState(id);
  try {
    await postJson(`/api/tools/${id}/run`, {});
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(2500);
      const data = await apiJson(`/api/tools/${id}/findings`);
      if (data.ranAt && data.ranAt !== prevRanAt) {
        await loadTool(id);
        t.runFinished = Date.now();
        break;
      }
      const logs = await apiJson("/api/logs?limit=30").catch(() => []);
      const failed = (Array.isArray(logs) ? logs : []).find((l) => l.tool === id && l.level === "error" && l.final !== false && new Date(l.time).getTime() >= t.runStarted - 2000);
      if (failed) throw new Error(failed.message || "the run failed");
    }
    if (!t.runFinished) throw new Error("timed out waiting for the run to finish");
  } catch (err) {
    t.runError = err.message;
  }
  t.running = false;
  if (state.route === `scan/${id}`) {
    if (t.runFinished) t.selectedRun = t.data.ranAt;
    renderScan(id);
  }
}
// Next to a failed scan: what failed, and when Graph or Azure refused, the
// permissions its identity needs.
const REFUSED = /\b40[13]\b|Forbidden|Authorization_?RequestDenied|AuthorizationFailed|Unauthorized|refused|permission|licen[cs]e|Premium|insufficient privileges/i;
function permsHint(id) {
  const t = toolState(id);
  const n = (TOOL_BY_ID[id] || {}).needs;
  const errs = [];
  if (t.runError) errs.push(t.runError);
  for (const [k, e] of Object.entries(t.tenantErrors || {})) errs.push(`${k}: ${typeof e === "string" ? e : (e && e.error) || "failed"}`);
  for (const f of t.data.findings || []) if (f.kind === "scan-error") errs.push(`${f.name}: ${f.detail || ""}`);
  if (!errs.length) return "";
  const when = t.data.ranAt ? ` From the run at ${fmt.dateTime(t.data.ranAt)}; errors stay until the next run.` : "";
  const list = `<ul class="err-list">${errs.slice(0, 6).map((e) => `<li>${esc(String(e).slice(0, 400))}</li>`).join("")}${errs.length > 6 ? `<li class="muted">and ${errs.length - 6} more</li>` : ""}</ul>`;
  if (!n || !errs.some((e) => REFUSED.test(e))) {
    return `<div class="perm-hint">${icon("shield")}<div><b>Part of the last run failed</b>${list}<p class="muted">This does not look like a missing permission. Running the scan again often clears it.${when}</p></div></div>`;
  }
  const codes = (xs) => xs.map((x) => `<code>${esc(x)}</code>`).join(" ");
  const rows = [
    n.graph && n.graph.length ? `<div class="perm-row"><span class="k">Microsoft Graph application permissions, with admin consent</span><span>${codes(n.graph)}</span></div>` : "",
    n.azure && n.azure.length ? `<div class="perm-row"><span class="k">Azure roles on each subscription (or a management group above them)</span><span>${codes(n.azure)}</span></div>` : "",
    n.licence ? `<div class="perm-row"><span class="k">Licence</span><span>${esc(n.licence)}</span></div>` : "",
  ].join("");
  const where = state.me && state.me.multiTenant ? " In a customer tenant that is the customer's own app registration." : "";
  const how = !(state.me && state.me.isAdmin) ? " An admin can check it in Settings." : state.me.multiTenant ? " Settings → Customer tenants → Test (or Test connection for the home tenant) lists what is missing." : " Settings → Test connection lists what is missing.";
  return `<div class="perm-hint">${icon("shield")}<div><b>The scan was refused access</b>${list}<p class="muted">What this scan needs:</p>${rows}<p class="muted">${where.trim()}${how}${when} A permission granted in the last day may not reach the scans yet (tokens are cached up to 24 hours).</p></div></div>`;
}
function renderPermsHint(id) {
  const el = $("#scan-perms");
  if (el && $("#page-scan").dataset.tool === id) el.innerHTML = permsHint(id);
}

function renderRunState(id) {
  const t = toolState(id);
  const btn = $("#scan-run");
  const st = $("#scan-status");
  if (!btn || $("#page-scan").dataset.tool !== id) return;
  btn.classList.toggle("hidden", !canRun(id));
  if (t.running) {
    const secs = Math.max(0, Math.round((Date.now() - t.runStarted) / 1000));
    btn.disabled = true;
    btn.classList.add("running");
    btn.innerHTML = `${icon("loader", "spin")} Running… ${secs}s`;
    setStatus(st, "Scanning. The results and the history update as soon as the run finishes.");
  } else {
    btn.disabled = false;
    btn.classList.remove("running");
    btn.innerHTML = `${icon("play")} Run now`;
    if (t.runError) setStatus(st, `Run failed: ${t.runError}`, "error");
    else if (t.runFinished && Date.now() - t.runFinished < 60000) {
      const last = t.history[t.history.length - 1] || {};
      if (TOOL_BY_ID[id].drawing) setStatus(st, "Run finished: the drawing is up to date.", "ok");
      else setStatus(st, `Run finished: ${fmt.int(t.data.findings.length)} findings (+${fmt.int(last.added || 0)} new, −${fmt.int(last.resolved || 0)} resolved).`, "ok");
    } else setStatus(st, "");
  }
  renderPermsHint(id);
}
function tickRunning() {
  const id = $("#page-scan").dataset.tool;
  if (id && toolState(id).running && state.route === `scan/${id}`) renderRunState(id);
}

/* ---------- boot ---------- */
async function init() {
  try {
    state.me = await apiJson("/api/me");
  } catch (err) {
    window.location.href = "/login.html";
    return;
  }
  if (!state.me.signedIn) {
    window.location.href = "/login.html";
    return;
  }
  // What each tool's identity needs, for the hint next to a failed scan.
  try {
    for (const x of await apiJson("/api/tools")) {
      if (TOOL_BY_ID[x.id]) Object.assign(TOOL_BY_ID[x.id], { needs: x.needs, areas: x.areas });
      else if (Array.isArray(x.areas)) PAGE_AREAS[x.id] = x.areas;
    }
  } catch {}
  initTenant();
  renderTenantTabs();
  $("#tenant-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tenant]");
    if (b) setTenant(b.dataset.tenant);
  });
  renderMe();
  buildNav();
  wireShell();
  wireLookup();
  wireScan();
  window.addEventListener("hashchange", render);
  render();
  setInterval(tickRunning, 1000);
  for (const t of shownTools()) if (!toolState(t.id).loaded) loadTool(t.id);
}
document.addEventListener("DOMContentLoaded", init);
