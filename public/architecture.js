"use strict";
/* Architecture scan page: a drawing of the environment from the inventory the last scan saved (/api/architecture).
   Pick resource groups (or whole subscriptions) on the left; the VNets and subnets their resources sit in are found
   by themselves, also when the network lives in another resource group. Two layouts: Network (VNets with their
   subnets, peerings, on-premises sites, everything else by resource group) and Resource groups (subscription,
   resource group, resource). Pan by dragging, zoom with the wheel; download as SVG, PNG or a draw.io file to edit.
   Everything is worked out in the browser. Uses app.js helpers. */
(() => {
  const ID = "architecture";
  const rerender = () => {
    if (state.route === `scan/${ID}`) renderFindings(ID);
  };
  const store = {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(`arch.${k}`));
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`arch.${k}`, JSON.stringify(v));
      } catch {
        /* a remembered choice is a nicety */
      }
    },
  };

  /* --- what each resource type looks like: [type, short, label, category] --- */
  const CATS = [
    ["compute", "Compute", "--s1"],
    ["web", "Web and apps", "--s7"],
    ["data", "Data and storage", "--s3"],
    ["network", "Network", "--s4"],
    ["security", "Identity and secrets", "--s5"],
    ["monitor", "Monitoring and backup", "--s2"],
    ["other", "Other", "--s-other"],
    ["support", "Supporting (disks, NSGs, alerts…)", "--s-other"],
  ];
  const TYPES = [
    ["compute/virtualmachines", "VM", "Virtual machine", "compute"],
    ["compute/virtualmachinescalesets", "VMSS", "Scale set", "compute"],
    ["containerservice/managedclusters", "AKS", "Kubernetes (AKS)", "compute"],
    ["containerinstance/containergroups", "ACI", "Container instance", "compute"],
    ["app/containerapps", "CA", "Container app", "compute"],
    ["app/managedenvironments", "CAE", "Container Apps environment", "compute"],
    ["containerregistry/registries", "ACR", "Container registry", "compute"],
    ["desktopvirtualization/hostpools", "AVD", "Virtual Desktop host pool", "compute"],
    ["batch/batchaccounts", "BAT", "Batch", "compute"],
    ["hybridcompute/machines", "ARC", "Arc server", "compute"],
    ["web/sites", "APP", "App Service", "web"],
    ["web/serverfarms", "PLAN", "App Service plan", "web"],
    ["web/staticsites", "SWA", "Static web app", "web"],
    ["apimanagement/service", "APIM", "API Management", "web"],
    ["logic/workflows", "LOGIC", "Logic app", "web"],
    ["signalrservice/signalr", "SIGR", "SignalR", "web"],
    ["cdn/profiles", "CDN", "Front Door / CDN", "web"],
    ["network/frontdoors", "AFD", "Front Door (classic)", "web"],
    ["storage/storageaccounts", "ST", "Storage account", "data"],
    ["sql/servers", "SQL", "SQL server", "data"],
    ["sql/servers/databases", "SQLDB", "SQL database", "data"],
    ["sql/servers/elasticpools", "POOL", "SQL elastic pool", "data"],
    ["sql/managedinstances", "SQLMI", "SQL managed instance", "data"],
    ["documentdb/databaseaccounts", "COS", "Cosmos DB", "data"],
    ["dbforpostgresql/flexibleservers", "PG", "PostgreSQL", "data"],
    ["dbformysql/flexibleservers", "MY", "MySQL", "data"],
    ["cache/redis", "RED", "Redis cache", "data"],
    ["datafactory/factories", "ADF", "Data Factory", "data"],
    ["synapse/workspaces", "SYN", "Synapse", "data"],
    ["databricks/workspaces", "DBX", "Databricks", "data"],
    ["eventhub/namespaces", "EH", "Event Hubs", "data"],
    ["servicebus/namespaces", "SB", "Service Bus", "data"],
    ["eventgrid/topics", "EG", "Event Grid topic", "data"],
    ["eventgrid/systemtopics", "EGS", "Event Grid system topic", "support"],
    ["search/searchservices", "SRCH", "AI Search", "data"],
    ["cognitiveservices/accounts", "AI", "Azure AI service", "data"],
    ["machinelearningservices/workspaces", "ML", "Machine Learning", "data"],
    ["network/virtualnetworks", "VNET", "Virtual network", "network"],
    ["network/azurefirewalls", "FW", "Azure Firewall", "network"],
    ["network/firewallpolicies", "FWP", "Firewall policy", "network"],
    ["network/applicationgateways", "AGW", "Application gateway", "network"],
    ["network/applicationgatewaywebapplicationfirewallpolicies", "WAF", "WAF policy", "network"],
    ["network/loadbalancers", "LB", "Load balancer", "network"],
    ["network/bastionhosts", "BAS", "Bastion", "network"],
    ["network/virtualnetworkgateways", "GW", "VPN / ExpressRoute gateway", "network"],
    ["network/localnetworkgateways", "SITE", "On-premises site", "network"],
    ["network/expressroutecircuits", "ER", "ExpressRoute circuit", "network"],
    ["network/privateendpoints", "PE", "Private endpoint", "network"],
    ["network/privatelinkservices", "PLS", "Private Link service", "network"],
    ["network/natgateways", "NAT", "NAT gateway", "network"],
    ["network/dnszones", "DNS", "DNS zone", "network"],
    ["network/privatednszones", "PDNS", "Private DNS zone", "network"],
    ["network/dnsresolvers", "DNSR", "DNS resolver", "network"],
    ["network/trafficmanagerprofiles", "TM", "Traffic Manager", "network"],
    ["network/virtualhubs", "HUB", "Virtual WAN hub", "network"],
    ["network/virtualwans", "VWAN", "Virtual WAN", "network"],
    ["network/ddosprotectionplans", "DDOS", "DDoS protection plan", "network"],
    ["network/publicipprefixes", "PIPP", "Public IP prefix", "network"],
    ["keyvault/vaults", "KV", "Key vault", "security"],
    ["managedidentity/userassignedidentities", "ID", "Managed identity", "security"],
    ["operationalinsights/workspaces", "LAW", "Log Analytics", "monitor"],
    ["insights/components", "APPI", "Application Insights", "monitor"],
    ["automation/automationaccounts", "AUTO", "Automation account", "monitor"],
    ["recoveryservices/vaults", "RSV", "Recovery Services vault", "monitor"],
    ["dataprotection/backupvaults", "BV", "Backup vault", "monitor"],
    ["insights/actiongroups", "AG", "Action group", "monitor"],
    ["network/networkinterfaces", "NIC", "Network interface", "network"],
    ["compute/disks", "DISK", "Disk", "support"],
    ["compute/snapshots", "SNAP", "Snapshot", "support"],
    ["network/publicipaddresses", "PIP", "Public IP", "support"],
    ["network/networksecuritygroups", "NSG", "Network security group", "support"],
    ["network/routetables", "RT", "Route table", "support"],
    ["network/networkwatchers", "NW", "Network Watcher", "support"],
    ["network/connections", "CONN", "Gateway connection", "support"],
    ["network/privatednszones/virtualnetworklinks", "LINK", "Private DNS link", "support"],
    ["compute/virtualmachines/extensions", "EXT", "VM extension", "support"],
    ["compute/availabilitysets", "AVS", "Availability set", "support"],
    ["compute/sshpublickeys", "SSH", "SSH key", "support"],
    ["compute/restorepointcollections", "RPC", "Restore points", "support"],
    ["insights/metricalerts", "ALRT", "Metric alert", "support"],
    ["insights/scheduledqueryrules", "ALRT", "Log alert", "support"],
    ["insights/activitylogalerts", "ALRT", "Activity log alert", "support"],
    ["insights/datacollectionrules", "DCR", "Data collection rule", "support"],
    ["insights/datacollectionendpoints", "DCE", "Data collection endpoint", "support"],
    ["alertsmanagement/smartdetectoralertrules", "ALRT", "Smart detector alert", "support"],
    ["operationsmanagement/solutions", "SOL", "Monitoring solution", "support"],
    ["portal/dashboards", "DASH", "Dashboard", "support"],
  ];
  const TYPE_BY = new Map(TYPES.map(([t, abbr, label, cat]) => [`microsoft.${t}`, { abbr, label, cat }]));
  function typeOf(r) {
    if (r.routeServer) return { abbr: "ARS", label: "Route Server", cat: "network" };
    const hit = TYPE_BY.get(r.type);
    if (hit) {
      if (r.type === "microsoft.web/sites" && /functionapp/i.test(r.kind || "")) return { ...hit, abbr: "FN", label: "Function app" };
      return hit;
    }
    // Unknown types: the last part of the type, in short.
    const last = String(r.type || "").split("/").pop() || "?";
    const words = last.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-z0-9]+/i).filter(Boolean);
    // A child type (three or more parts) is usually supporting detail.
    const child = String(r.type || "").split("/").length > 2;
    return { abbr: last.slice(0, 4).toUpperCase(), label: fmt.humanize(words.join(" ")), cat: child ? "support" : "other" };
  }

  /* --- data: loaded once per scan run --- */
  function inventory(t) {
    if (t.arch && t.arch.ranAt === t.data.ranAt) return t.arch;
    if (!t.archLoading) {
      const ranAt = t.data.ranAt;
      t.archLoading = apiJson("/api/architecture")
        .then((data) => (t.arch = { ranAt, data: prepare(data) }))
        .catch((err) => (t.arch = { ranAt, error: err.message }))
        .finally(() => {
          t.archLoading = null;
          rerender();
        });
    }
    return null;
  }
  const rgKey = (x) => `${x.tenant}|${x.subscriptionId}|${String(x.resourceGroup || x.name || "").toLowerCase()}`;
  function prepare(d) {
    const subName = new Map(d.subscriptions.map((s) => [`${s.tenant}|${s.id}`, s.name]));
    const tenantName = new Map(d.tenants.map((x) => [x.key, x.name]));
    const groups = new Map();
    const addGroup = (tenant, subscriptionId, name, displayName) => {
      const key = `${tenant}|${subscriptionId}|${name}`;
      if (!groups.has(key)) groups.set(key, { key, tenant, subscriptionId, name, displayName: displayName || name, count: 0, vnets: 0 });
      return groups.get(key);
    };
    for (const g of d.groups) addGroup(g.tenant, g.subscriptionId, g.name, g.displayName);
    for (const r of d.resources) {
      r.t = typeOf(r);
      const g = addGroup(r.tenant, r.subscriptionId, r.resourceGroup);
      if (r.t.cat !== "support") g.count++;
      if (r.type === "microsoft.network/virtualnetworks") g.vnets++;
    }
    const byId = new Map(d.resources.map((r) => [r.id, r]));
    const subnetById = new Map();
    for (const v of d.vnets) for (const s of v.subnets) subnetById.set(s.id, { s, v });
    return { ...d, subName, tenantName, groups, byId, subnetById };
  }

  /* --- the viewer's choices --- */
  function opts(t, inv) {
    if (t.archOpts) return t.archOpts;
    const saved = store.get("opts") || {};
    const savedScope = store.get("scope");
    const all = [...inv.groups.values()];
    const total = all.reduce((n, g) => n + g.count, 0);
    // A small tenant is drawn whole at first; a big one waits for a pick.
    const scope = new Set(Array.isArray(savedScope) ? savedScope.filter((k) => inv.groups.has(k)) : total <= 300 ? all.filter((g) => g.count).map((g) => g.key) : []);
    t.archOpts = {
      scope,
      layout: saved.layout === "groups" || saved.layout === "network" ? saved.layout : "hubs",
      cats: new Set(Array.isArray(saved.cats) ? saved.cats : CATS.map(([c]) => c).filter((c) => c !== "support")),
      subs: saved.subs !== false,
      peerings: saved.peerings !== false,
      onprem: saved.onprem !== false,
      publicIps: saved.publicIps !== false,
      peLinks: saved.peLinks !== false,
      wholeVnets: !!saved.wholeVnets,
      grouped: saved.grouped || "auto",
      traffic: TRAFFIC.some(([k]) => k === saved.traffic) ? saved.traffic : "",
      ports: typeof saved.ports === "string" ? saved.ports : "",
      dir: saved.dir === "out" ? "out" : "in",
      flowBlocked: !!saved.flowBlocked,
      flowColor: saved.flowColor === "state" ? "state" : "vm",
      flowSame: !!saved.flowSame,
      fwVms: saved.fwVms !== false,
      pick: new Set(Array.isArray(store.get("pick")) ? store.get("pick") : []),
      hide: new Set(Array.isArray(store.get("hide")) ? store.get("hide") : []),
      openRg: new Set(),
      find: "",
      open: new Set(),
      view: null,
      refit: true,
      sel: null,
    };
    return t.archOpts;
  }
  function saveOpts(o) {
    store.set("scope", [...o.scope]);
    store.set("pick", [...o.pick]);
    store.set("hide", [...o.hide]);
    store.set("opts", { layout: o.layout, cats: [...o.cats], subs: o.subs, peerings: o.peerings, onprem: o.onprem, publicIps: o.publicIps, peLinks: o.peLinks, wholeVnets: o.wholeVnets, grouped: o.grouped, traffic: o.traffic, ports: o.ports, dir: o.dir, flowBlocked: o.flowBlocked, flowColor: o.flowColor, flowSame: o.flowSame, fwVms: o.fwVms });
  }

  /* --- traffic lines: can the picked tile talk to the others on these ports? --- */
  const TRAFFIC = [
    ["", "Traffic: off"],
    ["all", "Traffic: all ports"],
    ["ad", "Traffic: domain controller (AD)"],
    ["rdp", "Traffic: RDP"],
    ["ssh", "Traffic: SSH"],
    ["smb", "Traffic: file share (SMB)"],
    ["sql", "Traffic: SQL Server"],
    ["web", "Traffic: web (80, 443)"],
    ["winrm", "Traffic: WinRM"],
    ["custom", "Traffic: my own ports"],
  ];
  // A NIC is drawn too, but its VM or private endpoint stands for it.
  const TALKS = new Set(["microsoft.compute/virtualmachines", "microsoft.network/privateendpoints"]);
  // A firewall VM (IP forwarding, or a route's next hop) carries traffic for others: it gets no lines of its own.
  const talks = (r) => TALKS.has(r.type) && !r.appliance;
  function drawnLeaves(n, out = []) {
    for (const c of n.children || []) c.leaf ? out.push(c) : drawnLeaves(c, out);
    return out;
  }
  // The answer for the picked tile, or null while it is asked for (the page draws again when it comes).
  // The answer for the drawing, or null while it is asked for (the page draws again when it comes). With a VM
  // picked: its traffic in or out; with none: every drawn VM to every other one (and to the private endpoints).
  function trafficFor(t, m, o) {
    if (!o.traffic || (o.traffic === "custom" && !o.ports.trim())) return null;
    const leaves = drawnLeaves(m.root);
    const all = leaves.flatMap((l) => l.many || [l.r]).filter(talks);
    const sel = o.sel && leaves.find((l) => l.key === o.sel);
    const mine = sel ? (sel.many || [sel.r]).filter(talks) : [];
    const ports = o.traffic === "custom" ? { ports: o.ports } : { preset: o.traffic };
    const ids = (rs) => rs.map((r) => r.id);
    const bodies = [];
    if (mine.length) {
      const tenant = mine[0].tenant;
      const others = leaves.filter((l) => l !== sel).flatMap((l) => l.many || [l.r]).filter((r) => talks(r) && r.tenant === tenant);
      if (!others.length) return { quiet: "No other VMs or private endpoints are drawn to check against." };
      bodies.push({ tenant, ...ports, from: ids(o.dir === "in" ? others : mine), to: ids(o.dir === "in" ? mine : others) });
    } else {
      // A private endpoint only answers, so the lines start from VMs.
      for (const tenant of new Set(all.map((r) => r.tenant))) {
        const here = all.filter((r) => r.tenant === tenant);
        const vms = here.filter((r) => r.type === "microsoft.compute/virtualmachines");
        if (vms.length && here.length > 1) bodies.push({ tenant, ...ports, brief: true, from: ids(vms), to: ids(here) });
      }
      if (!bodies.length) return { auto: true, quiet: "No VMs are drawn: pick resource groups with VMs in them." };
    }
    const key = JSON.stringify([t.data.ranAt, bodies]);
    const c = t.archFlow;
    if (c && c.key === key) return c;
    if (t.archFlowAsk !== key) {
      t.archFlowAsk = key;
      t.archFlow = { key, loading: true, auto: !mine.length };
      Promise.all(bodies.map((b) => postJson("/api/architecture/flows", b)))
        .then((rs) => ({
          key,
          auto: !mine.length,
          checks: rs[0].checks,
          results: rs.flatMap((r) => r.results),
          capped: rs.some((r) => r.capped),
          note: rs.map((r) => r.note).find(Boolean),
          missing: rs.map((r) => r.missing).find(Boolean),
        }))
        .catch((err) => ({ key, error: err.message }))
        .then((r) => {
          if (t.archFlowAsk !== key) return;
          t.archFlow = r;
          t.archFlowAsk = null;
          rerender();
        });
    }
    return t.archFlow;
  }
  const FLOW_WORD = { allow: "open", part: "partly open", deny: "blocked", unknown: "unknown", none: "no address" };
  function flowLinks(m, f, o) {
    if (!f || !f.results) return;
    const tile = new Map(), subnet = new Map();
    for (const l of drawnLeaves(m.root)) for (const r of l.many || [l.r]) tile.set(r.id, l.key), subnet.set(r.id, r.subnet);
    const lines = new Map();
    // Over the whole drawing, each tile gets one line to a firewall its traffic passes, with the number of pairs
    // on it; the pairs one by one show when a VM is clicked.
    const trunks = new Map();
    const trunk = (t, fw, way, state, text) => {
      const k = `${t}|${fw}`;
      const x = trunks.get(k) || { t, fw, out: false, in: false, states: new Set(), n: 0, texts: [], ends: new Set() };
      x[way] = true;
      x.states.add(state);
      x.n++;
      for (const e of ends) x.ends.add(e);
      if (x.texts.length < 12) x.texts.push(text);
      trunks.set(k, x);
    };
    f.sameLeft = 0;
    const byVm = o.flowColor === "vm";
    let src = null, ends = [];
    const add = (a, b, state, fw, text) => {
      if (!a || !b || a === b) return;
      // Coloured by VM: one line per sender, so lines from two VMs to the same tile stay apart.
      const k = byVm ? `${src}|${a}|${b}` : `${a}|${b}`;
      const x = lines.get(k) || { a, b, src, states: new Set(), fw: false, texts: [], ends: new Set() };
      x.states.add(state);
      x.fw = x.fw || fw;
      for (const e of ends) x.ends.add(e);
      if (x.texts.length < 12) x.texts.push(text);
      lines.set(k, x);
    };
    for (const r of f.results) {
      if (r.state === "none") continue;
      // Over the whole drawing, blocked pairs are left out unless asked for: most pairs are blocked on purpose.
      if (f.auto && !o.flowBlocked && r.state === "deny") continue;
      // Two VMs in one subnet nearly always reach each other: left out unless asked for.
      if (f.auto && !o.flowSame && subnet.get(r.from) && subnet.get(r.from) === subnet.get(r.to)) {
        f.sameLeft++;
        continue;
      }
      const a = tile.get(r.from), b = tile.get(r.to);
      src = a;
      ends = [a, b];
      const name = (id) => id.split("/").pop();
      const bad = (r.checks || []).filter((c) => c.ok !== "all").map((c) => `${c.label}${c.open ? ` (open: ${c.open})` : c.by ? ` (${c.by})` : ""}`);
      const text = `${name(r.from)} → ${name(r.to)}: ${FLOW_WORD[r.state]}, ${r.via}${bad.length && r.state !== "deny" ? `\n  ${bad.join("\n  ")}` : r.why ? `\n  ${r.why}` : ""}`;
      const mid = r.fw || r.hop;
      const fwTile = mid && tile.get(mid);
      if (fwTile && fwTile !== a && fwTile !== b && f.auto) {
        trunk(a, fwTile, "out", r.state, text);
        trunk(b, fwTile, "in", r.state, text);
      } else if (fwTile && fwTile !== a && fwTile !== b) {
        add(a, fwTile, r.state, true, text);
        add(fwTile, b, r.state, true, text);
      } else add(a, b, r.state, !!mid, text);
    }
    const stateOf = (x) => (x.states.size === 1 ? [...x.states][0] : "part");
    // Each VM that sends gets its own colour, in a steady order so a colour stays with its VM between redraws.
    const senders = [...new Set([...[...lines.values()].map((x) => x.src), ...[...trunks.values()].filter((x) => x.out).map((x) => x.t)])].filter(Boolean).sort();
    const vmCol = new Map(senders.map((k, i) => [k, VM_COLORS[i % VM_COLORS.length]]));
    o.vmCol = byVm ? vmCol : null;
    for (const [k, x] of lines) {
      if (x.gone) continue;
      // Both ways alike: one line with an arrow at each end (only when coloured by result: by VM each way has its sender's colour).
      const back = !byVm && lines.get(`${x.b}|${x.a}`);
      const both = back && !back.gone && stateOf(back) === stateOf(x) && back.fw === x.fw;
      if (both) back.gone = true;
      const on = new Set([...x.ends, x.a, x.b, ...(both ? back.ends : [])]);
      m.links.push({ a: x.a, b: x.b, kind: `flow-${stateOf(x)}`, flow: stateOf(x), col: byVm ? vmCol.get(x.src) : null, on: [...on], arrow: true, both, dash: !byVm && x.fw, title: [...x.texts, ...(both ? back.texts : [])].slice(0, 16).join("\n") });
    }
    for (const x of trunks.values()) {
      const st = stateOf(x);
      // The arrow points the way the traffic goes: into the firewall from a sender, out of it to a receiver.
      const [a, b] = x.out ? [x.t, x.fw] : [x.fw, x.t];
      const head = `${x.n} pair${x.n > 1 ? "s" : ""} through the firewall${x.n > 1 ? " (click a VM to see them one by one)" : ""}`;
      // Coloured by VM, a tile that only receives has a grey line: it has no colour of its own.
      m.links.push({ a, b, kind: `flow-${st}`, flow: st, col: byVm ? vmCol.get(x.t) || "grey" : null, on: [...x.ends, x.t, x.fw], arrow: true, both: x.out && x.in, dash: !byVm, trunk: x.n, title: [head, ...x.texts].join("\n") });
    }
  }
  // Line colours for "colour by VM": easy to tell apart, readable on light and dark.
  // No blue: that is the peering colour.
  const VM_COLORS = ["#f08c00", "#12b886", "#d6336c", "#845ef7", "#b07d2b", "#74b816", "#ae3ec9", "#15aabf", "#e8590c", "#0b7285"];
  // Coloured by VM the result shows in the line: solid gets through, dashed some ports, dotted blocked or unknown.
  const FLOW_DASH = { allow: "", part: "9 4", deny: "2 4", unknown: "1 5" };

  /* --- the model: a tree of boxes and resources, plus the lines between them --- */
  const LW = 196, LH = 46, GAP = 14, PAD = 12;
  const box = (key, kind, label, sub, extra = {}) => ({ key, kind, label, sub, tags: [], children: [], ...extra });
  const leaf = (r) => ({ key: r.id, leaf: true, r, label: r.name, sub: r.appliance ? "Firewall VM" : r.t.label });

  function model(inv, o) {
    const show = (r) => o.cats.has(r.t.cat);
    // A resource left out also takes its NICs along; one picked on its own counts as picked.
    const owner = (r) => (r.type === "microsoft.network/networkinterfaces" && r.link && inv.byId.get(r.link)) || r;
    const hidden = (r) => o.hide.has(r.id) || o.hide.has(owner(r).id) || (!o.fwVms && owner(r).appliance);
    const picked = (r) => !hidden(r) && (o.scope.has(rgKey(r)) || o.pick.has(r.id) || o.pick.has(owner(r).id));
    const multi = inv.tenants.length > 1;
    const subLabel = (tenant, id) => inv.subName.get(`${tenant}|${id}`) || id;
    const groupLabel = (key) => {
      const g = inv.groups.get(key);
      return g ? g.displayName : key.split("|").pop();
    };
    const links = [];
    const roots = new Map(); // tenant -> box
    const tenantBox = (tenant) => {
      if (!roots.has(tenant)) roots.set(tenant, box(`tenant:${tenant}`, "tenant", inv.tenantName.get(tenant) || tenant, "tenant"));
      return roots.get(tenant);
    };
    // Firewalls the traffic lines pass through are drawn even when their group or kind is not picked.
    const through = o.through || new Set();
    const resources = inv.resources.filter((r) => (show(r) && picked(r)) || (through.has(r.id) && !hidden(r)));
    let leaves = 0;

    if (o.layout === "groups") {
      // Subscription > resource group > resource.
      const subBoxes = new Map(), rgBoxes = new Map();
      for (const r of resources) {
        const k = rgKey(r);
        if (!rgBoxes.has(k)) {
          const rg = box(`rg:${k}`, "rg", groupLabel(k), o.subs ? "" : subLabel(r.tenant, r.subscriptionId));
          rgBoxes.set(k, rg);
          const parent = o.subs
            ? subBoxes.get(`${r.tenant}|${r.subscriptionId}`) ||
              subBoxes.set(`${r.tenant}|${r.subscriptionId}`, box(`sub:${r.tenant}|${r.subscriptionId}`, "sub", subLabel(r.tenant, r.subscriptionId), "subscription")).get(`${r.tenant}|${r.subscriptionId}`)
            : tenantBox(r.tenant);
          parent.children.push(rg);
        }
        rgBoxes.get(k).children.push(leaf(r));
        leaves++;
      }
      for (const [k, s] of subBoxes) tenantBox(k.split("|")[0]).children.push(s);
    } else {
      // Network: VNets with the subnets the picked resources sit in, then the rest by resource group.
      const vnetBoxes = new Map(), subnetBoxes = new Map(), rgBoxes = new Map();
      const whole = new Set(inv.vnets.filter((v) => o.scope.has(rgKey(v))).map((v) => v.id));
      const vnetBox = (v) => {
        if (!vnetBoxes.has(v.id)) {
          const peers = v.peerings.length;
          const b = box(v.id, "vnet", v.name, [v.prefixes.join(", "), `rg ${v.resourceGroup}`, subLabel(v.tenant, v.subscriptionId)].filter(Boolean).join(" · "), { v, prio: -peers });
          vnetBoxes.set(v.id, b);
          tenantBox(v.tenant).children.push(b);
        }
        return vnetBoxes.get(v.id);
      };
      const subnetBox = (s, v) => {
        if (!subnetBoxes.has(s.id)) {
          const b = box(s.id, "subnet", s.name, s.prefixes.join(", "), { s });
          const special = /^(GatewaySubnet|AzureFirewallSubnet|AzureFirewallManagementSubnet|RouteServerSubnet)$/i.test(s.name);
          if (s.nsg) b.tags.push(["NSG", "good", `Network security group ${s.nsg}`]);
          else if (!special) b.tags.push(["no NSG", "warn", "No network security group on this subnet"]);
          if (s.routeTable) b.tags.push(["UDR", "", `Route table ${s.routeTable}`]);
          if (s.natGateway) b.tags.push(["NAT", "", `NAT gateway ${s.natGateway}`]);
          if (s.delegation) b.tags.push([s.delegation.split("/").pop(), "", `Delegated to ${s.delegation}`]);
          subnetBoxes.set(s.id, b);
          vnetBox(v).children.push(b);
        }
        return subnetBoxes.get(s.id);
      };
      const isSite = (r) => r.type === "microsoft.network/localnetworkgateways" || r.type === "microsoft.network/expressroutecircuits";
      const placed = [];
      const inSubnet = (r) => r.subnet && inv.subnetById.get(r.subnet);
      // A VNet picked through its own resource group comes whole, with what sits in it from elsewhere.
      const extra = inv.resources.filter((r) => show(r) && !picked(r) && !hidden(r) && inSubnet(r) && whole.has(inv.subnetById.get(r.subnet).v.id));
      for (const r of [...resources, ...extra]) {
        if (r.type === "microsoft.network/virtualnetworks") continue; // drawn as its box
        if (o.onprem && isSite(r)) continue; // drawn in the on-premises box
        const at = inSubnet(r);
        if (at) {
          const l = leaf(r);
          if (r.type === "microsoft.web/sites") l.sub = `${r.t.label} · VNet integration`;
          if (!picked(r) || !show(r)) l.context = true;
          subnetBox(at.s, at.v).children.push(l);
        } else {
          const k = rgKey(r);
          if (!rgBoxes.has(k)) {
            rgBoxes.set(k, box(`rg:${k}`, "rg", groupLabel(k), subLabel(r.tenant, r.subscriptionId), { prio: 1000 }));
            tenantBox(r.tenant).children.push(rgBoxes.get(k));
          }
          rgBoxes.get(k).children.push(leaf(r));
        }
        placed.push(r);
        leaves++;
      }
      // Whole VNets: every subnet, empty ones too, and the network itself even with nothing in it.
      for (const v of inv.vnets) {
        if (whole.has(v.id)) {
          vnetBox(v);
          for (const s of v.subnets) subnetBox(s, v);
        } else if (vnetBoxes.has(v.id) && o.wholeVnets) {
          for (const s of v.subnets) subnetBox(s, v);
        }
      }
      for (const [id, b] of vnetBoxes) {
        const v = b.v;
        const hidden = v.subnets.length - b.children.length;
        if (hidden > 0) b.tags.push([`+${hidden} subnet${hidden === 1 ? "" : "s"}`, "", `${hidden} subnet${hidden === 1 ? "" : "s"} with nothing picked in ${hidden === 1 ? "it" : "them"} (Whole VNets shows them)`]);
        const out = v.peerings.filter((p) => !vnetBoxes.has(p.remote));
        if (out.length) b.tags.push([`${out.length} peering${out.length === 1 ? "" : "s"} off the drawing`, "", out.map((p) => p.remote.split("/").pop()).join(", ")]);
        if (o.peerings) {
          for (const p of v.peerings) {
            if (vnetBoxes.has(p.remote) && id < p.remote) links.push({ a: id, b: p.remote, kind: /connected/i.test(p.state) ? "peer" : "peer-bad", title: `Peering ${v.name} – ${p.remote.split("/").pop()} (${p.state || "state unknown"})` });
            if (vnetBoxes.has(p.remote) && id > p.remote && !inv.vnets.some((x) => x.id === p.remote && x.peerings.some((q) => q.remote === id))) {
              links.push({ a: id, b: p.remote, kind: "peer-bad", title: `Peering ${v.name} – ${p.remote.split("/").pop()} is set up on one side only` });
            }
          }
        }
      }
      if (o.layout === "hubs") for (const t of roots.values()) findHubs(t);
      // On-premises: sites connected to a gateway that is on the drawing.
      if (o.onprem) {
        const drawnIds = new Set(placed.map((r) => r.id));
        const sites = new Map();
        for (const c of inv.connections) {
          if (!drawnIds.has(c.gateway)) continue;
          const site = inv.byId.get(c.site);
          if (!site || !isSite(site)) continue;
          if (!sites.has(site.id)) sites.set(site.id, site);
          links.push({ a: site.id, b: c.gateway, kind: "vpn", title: `${c.name} (${c.kind || "connection"})` });
        }
        // Picked sites with no drawn gateway still show.
        for (const r of resources) if (isSite(r)) sites.set(r.id, r);
        const byTenant = new Map();
        for (const s of sites.values()) {
          if (!byTenant.has(s.tenant)) {
            byTenant.set(s.tenant, box(`onprem:${s.tenant}`, "onprem", "On-premises and other networks", "", { prio: -10000 }));
            tenantBox(s.tenant).children.push(byTenant.get(s.tenant));
          }
          const site = inv.sites.find((x) => x.id === s.id);
          const l = leaf(s);
          if (site) l.sub = site.type === "microsoft.network/expressroutecircuits" ? `ExpressRoute${site.provider ? " · " + site.provider : ""}` : site.prefixes.join(", ") || s.t.label;
          byTenant.get(s.tenant).children.push(l);
          leaves++;
        }
      }
      if (o.peLinks) {
        const drawn = new Set([...subnetBoxes.values()].flatMap((b) => b.children.map((c) => c.key)).concat([...rgBoxes.values()].flatMap((b) => b.children.map((c) => c.key))));
        for (const r of placed) {
          if (r.type !== "microsoft.network/privateendpoints" || !r.link) continue;
          const target = r.link.split("/").slice(0, 9).join("/");
          if (drawn.has(target)) links.push({ a: r.id, b: target, kind: "pe", title: `${r.name} is a private endpoint for ${target.split("/").pop()}` });
        }
      }
    }
    const tops = [...roots.values()];
    const root = multi ? box("root", "root", "", "", { children: tops }) : tops[0] || box("root", "root", "", "");
    root.kind = "root"; // the outer box draws no frame of its own
    const grouped = o.grouped === "type" || (o.grouped === "auto" && leaves > 400);
    if (grouped) groupByType(root);
    return { root, links, leaves, grouped, multi };
  }
  // Big drawings: one tile per type in each box ("VM ×12").
  function groupByType(n) {
    if (n.leaf) return;
    const keep = [], byType = new Map();
    for (const c of n.children) {
      if (!c.leaf) {
        groupByType(c);
        keep.push(c);
        continue;
      }
      if (!byType.has(c.r.type)) byType.set(c.r.type, []);
      byType.get(c.r.type).push(c);
    }
    for (const [type, list] of byType) {
      if (list.length === 1) keep.push(list[0]);
      else keep.push({ key: `${n.key}|${type}`, leaf: true, r: list[0].r, many: list.map((x) => x.r), label: `${list[0].r.t.label} ×${list.length}`, sub: list.slice(0, 3).map((x) => x.r.name).join(", ") + (list.length > 3 ? "…" : "") });
    }
    n.children = keep;
  }

  // Hub and spoke: a hub is a VNet peered with two or more drawn VNets (one holding a gateway or firewall subnet
  // counts with one), most peerings first; its peers not yet taken are its spokes. Spoke-to-spoke peerings stay
  // lines. Kept on the box that holds the VNets, for measure().
  const CORE_SUBNET = /^(GatewaySubnet|AzureFirewallSubnet|RouteServerSubnet)$/i;
  function findHubs(t) {
    const vnets = t.children.filter((c) => c.kind === "vnet");
    const byId = new Map(vnets.map((b) => [b.key, b]));
    const peers = new Map(vnets.map((b) => [b.key, [...new Set(b.v.peerings.map((p) => p.remote))].filter((id) => byId.has(id) && id !== b.key)]));
    const core = (b) => (b.v.subnets.some((s) => CORE_SUBNET.test(s.name)) ? 0.5 : 0);
    const rank = (b) => peers.get(b.key).length + core(b);
    const taken = new Set(), hubs = [];
    for (const h of [...vnets].sort((a, b) => rank(b) - rank(a) || String(a.label).localeCompare(String(b.label)))) {
      if (taken.has(h.key)) continue;
      const spokes = peers.get(h.key).map((id) => byId.get(id)).filter((b) => !taken.has(b.key));
      if (spokes.length < 2 && !(spokes.length && core(h))) continue;
      taken.add(h.key);
      for (const b of spokes) taken.add(b.key);
      h.tags.unshift(["hub", "", `Hub: peered with ${spokes.length} spoke${spokes.length === 1 ? "" : "s"} on the drawing`]);
      hubs.push({ hub: h, spokes: spokes.sort((a, b) => String(a.label).localeCompare(String(b.label))) });
    }
    if (hubs.length) t.hubs = hubs;
  }
  // Each hub in the middle with rows of spokes above and below, on-premises on its left; hubs side by side, and
  // everything else (other VNets, resource groups) in rows underneath. False when there is nothing to do.
  function hubLayout(n) {
    if (!n.hubs || n.children.some((c) => c.leaf)) return false;
    const BAND = GAP * 4;
    const used = new Set();
    const side = n.children.find((c) => c.kind === "onprem");
    const clusters = n.hubs.map(({ hub, spokes }, i) => {
      const items = [];
      const left = i === 0 && side;
      used.add(hub);
      // Rows of spokes about as wide as the hub row, but roughly square overall when there are many.
      const area = spokes.reduce((s, b) => s + (b.w + BAND) * (b.h + BAND), 0);
      const T = Math.max(hub.w + (left ? left.w + BAND : 0), Math.sqrt(area) * 1.6);
      const rows = [];
      for (const b of spokes) {
        used.add(b);
        const row = rows[rows.length - 1];
        if (row && row.w + 2 * GAP + b.w <= T) (row.items.push(b), (row.w += 2 * GAP + b.w), (row.h = Math.max(row.h, b.h)));
        else rows.push({ items: [b], w: b.w, h: b.h });
      }
      // Rows go above and below in turn, the first ones nearest the hub; x is measured from the hub's centre.
      let up = 0, down = hub.h;
      rows.forEach((row, j) => {
        let x = -row.w / 2;
        const above = j % 2 === 0;
        const y = above ? up - BAND - row.h : down + BAND;
        for (const b of row.items) {
          items.push([b, x, above ? y + row.h - b.h : y]);
          x += b.w + 2 * GAP;
        }
        if (above) up = y;
        else down = y + row.h;
      });
      items.push([hub, -hub.w / 2, 0]);
      if (left) {
        used.add(left);
        items.push([left, -hub.w / 2 - BAND - left.w, (hub.h - left.h) / 2]);
      }
      const x0 = Math.min(...items.map(([, x]) => x)), y0 = Math.min(...items.map(([, , y]) => y));
      const w = Math.max(...items.map(([b, x]) => x + b.w)) - x0, h = Math.max(...items.map(([b, , y]) => y + b.h)) - y0;
      return { items: items.map(([b, x, y]) => [b, x - x0, y - y0]), w, h, hubY: -y0 };
    });
    // Hubs on one line.
    const hubY = Math.max(...clusters.map((c) => c.hubY));
    let x = 0, bottom = 0;
    for (const c of clusters) {
      for (const [b, bx, by] of c.items) (b.x = x + bx), (b.y = hubY - c.hubY + by);
      bottom = Math.max(bottom, hubY - c.hubY + c.h);
      x += c.w + BAND * 2;
    }
    const clW = x - BAND * 2;
    const rest = n.children.filter((c) => !used.has(c)).sort((a, b) => (a.prio || 0) - (b.prio || 0) || b.h - a.h || String(a.label).localeCompare(String(b.label)));
    const area = rest.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0);
    // A tall hub group has the rest on its right (screens are wide), a wide one has it underneath.
    const beside = rest.length && bottom > clW * 0.9;
    const T = beside ? Math.max(Math.sqrt(area) * 1.2, ...rest.map((b) => b.w)) : Math.max(clW, Math.sqrt(area) * 1.9, ...rest.map((b) => b.w));
    const ox = beside ? clW + BAND * 2 : 0;
    let rx = 0, ry = beside ? 0 : bottom + (rest.length ? BAND : 0), rowH = 0, packW = clW;
    for (const b of rest) {
      if (rx > 0 && rx + b.w > T) (rx = 0), (ry += rowH + GAP), (rowH = 0);
      b.x = ox + rx;
      b.y = ry;
      rx += b.w + GAP;
      rowH = Math.max(rowH, b.h);
      packW = Math.max(packW, b.x + b.w);
    }
    const pad = n.kind === "root" ? 0 : PAD, head = headH(n);
    for (const b of n.children) (b.x += pad), (b.y += head + pad);
    n.w = Math.max(packW, n.kind === "root" ? 0 : headW(n), 120) + pad * 2;
    n.h = head + pad + Math.max(bottom, ry + rowH) + pad;
    return true;
  }

  /* --- layout: boxes sized from the inside out, children in rows --- */
  const textW = (s, px = 7) => String(s || "").length * px;
  const headH = (n) => (n.kind === "root" ? 0 : n.sub ? 42 : 28);
  function headW(n) {
    const tags = n.tags.reduce((w, [label]) => w + textW(label, 6) + 18, 0);
    return Math.max(textW(n.label, 7.4) + tags + 12, textW(n.sub, 6.2));
  }
  function measure(n) {
    if (n.leaf) {
      n.w = LW;
      n.h = LH;
      return;
    }
    n.children.forEach(measure);
    if (hubLayout(n)) return;
    const leaves = n.children.filter((c) => c.leaf);
    const boxes = n.children.filter((c) => !c.leaf).sort((a, b) => (a.prio || 0) - (b.prio || 0) || b.h - a.h || String(a.label).localeCompare(String(b.label)));
    const area = boxes.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0);
    const maxW = boxes.reduce((m, b) => Math.max(m, b.w), 0);
    let target = Math.max(maxW, Math.sqrt(area) * (n.kind === "root" || n.kind === "tenant" ? 1.9 : 1.5));
    let cols = 0;
    if (leaves.length) {
      cols = boxes.length ? Math.floor((Math.max(target, 3 * LW + 2 * GAP) + GAP) / (LW + GAP)) : Math.ceil(Math.sqrt(leaves.length * 2.2));
      cols = Math.max(1, Math.min(cols, leaves.length, 8));
    }
    const leafW = cols ? cols * LW + (cols - 1) * GAP : 0;
    const rows = cols ? Math.ceil(leaves.length / cols) : 0;
    const leafH = rows ? rows * LH + (rows - 1) * GAP : 0;
    target = Math.max(target, leafW);
    // Rows of boxes.
    let x = 0, y = 0, rowH = 0, packW = 0;
    for (const b of boxes) {
      if (x > 0 && x + b.w > target) {
        x = 0;
        y += rowH + GAP;
        rowH = 0;
      }
      b.x = x;
      b.y = y;
      x += b.w + GAP;
      rowH = Math.max(rowH, b.h);
      packW = Math.max(packW, b.x + b.w);
    }
    const packH = boxes.length ? y + rowH : 0;
    const pad = n.kind === "root" ? 0 : PAD;
    const head = headH(n);
    leaves.forEach((l, i) => {
      l.x = pad + (i % cols) * (LW + GAP);
      l.y = head + pad + Math.floor(i / cols) * (LH + GAP);
    });
    const by = head + pad + leafH + (leafH && boxes.length ? GAP : 0);
    for (const b of boxes) {
      b.x += pad;
      b.y += by;
    }
    n.children = [...leaves, ...boxes];
    n.w = Math.max(leafW, packW, n.kind === "root" ? 0 : headW(n), 120) + pad * 2;
    n.h = Math.max(by + packH + pad, head + 30);
  }
  function place(n, x, y, at) {
    n.ax = x + (n.x || 0);
    n.ay = y + (n.y || 0);
    at.set(n.key, n);
    if (!n.leaf) for (const c of n.children) place(c, n.ax, n.ay, at);
  }

  /* --- drawing --- */
  // Microsoft's Azure architecture icons (public/icons, terms in NOTICE.md there), fetched once. Until they come,
  // or for a kind without one, the tile shows its short name.
  let ICONS = null, iconsAsked = false, iconsUsed = new Set();
  function loadIcons() {
    if (iconsAsked) return;
    iconsAsked = true;
    fetch("/icons/azure-icons.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || !j.icons) return;
        ICONS = j;
        rerender();
      })
      .catch(() => {
        /* the short names stay */
      });
  }
  // [icon number, draw.io path] for a tile's short name, or null.
  const iconOf = (abbr) => {
    const m = ICONS && ICONS.map[abbr];
    return m && ICONS.icons[m[0]] ? m : null;
  };
  // The icons drawn, as symbols in the drawing itself, so the SVG and PNG downloads carry them too.
  const iconDefs = () =>
    iconsUsed.size ? `<defs>${[...iconsUsed].map((n) => `<symbol id="az-${n}" viewBox="${esc(ICONS.icons[n].vb)}">${ICONS.icons[n].body}</symbol>`).join("")}</defs>` : "";
  function palette() {
    const css = getComputedStyle(document.documentElement);
    const v = (k) => css.getPropertyValue(k).trim();
    const p = {};
    for (const k of ["--bg", "--surface", "--surface-2", "--surface-3", "--border", "--border-strong", "--text", "--text-2", "--muted", "--accent", "--accent-text", "--good-text", "--warning", "--critical", "--critical-text", "--font", "--mono"]) p[k] = v(k);
    for (const [c, , k] of CATS) p[c] = v(k);
    return p;
  }
  const BOX_STYLE = {
    tenant: (p) => ({ fill: "none", stroke: p["--border-strong"], dash: "", title: p["--text"] }),
    sub: (p) => ({ fill: "none", stroke: p["--border-strong"], dash: "6 4", title: p["--text"] }),
    rg: (p) => ({ fill: p["--surface"], stroke: p["--border-strong"], dash: "", title: p["--text"] }),
    vnet: (p) => ({ fill: "rgba(57,135,229,0.07)", stroke: p["--accent"], dash: "", title: p["--accent-text"] }),
    subnet: (p) => ({ fill: p["--surface"], stroke: p["--accent"], dash: "4 3", title: p["--text"] }),
    onprem: (p) => ({ fill: "rgba(250,178,25,0.06)", stroke: p["--warning"], dash: "6 4", title: p["--warning"] }),
  };
  const trunc = (s, n) => (String(s || "").length > n ? String(s).slice(0, n - 1) + "…" : String(s || ""));
  function drawBox(n, p, out) {
    if (n.kind !== "root") {
      const st = BOX_STYLE[n.kind](p);
      out.push(`<g data-arch-box="${esc(n.key)}"><rect x="${n.ax}" y="${n.ay}" width="${n.w}" height="${n.h}" rx="8" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.2"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}/>`);
      const kindWord = { tenant: "TENANT", sub: "SUBSCRIPTION", rg: "RESOURCE GROUP", vnet: "VNET", subnet: "SUBNET", onprem: "" }[n.kind];
      let tx = n.ax + PAD;
      out.push(`<text x="${tx}" y="${n.ay + 19}" font-size="13" font-weight="600" fill="${st.title}"><title>${esc(kindWord ? kindWord.toLowerCase() + " " : "")}${esc(n.label)}</title>${esc(trunc(n.label, 60))}</text>`);
      tx += textW(trunc(n.label, 60), 7.4) + 10;
      for (const [label, cls, title] of n.tags) {
        const w = textW(label, 6) + 12;
        const col = cls === "good" ? p["--good-text"] : cls === "warn" ? p["--warning"] : p["--muted"];
        out.push(`<g><title>${esc(title)}</title><rect x="${tx}" y="${n.ay + 7}" width="${w}" height="17" rx="8.5" fill="none" stroke="${col}" stroke-opacity="0.7"/><text x="${tx + 6}" y="${n.ay + 19}" font-size="10" fill="${col}">${esc(label)}</text></g>`);
        tx += w + 6;
      }
      if (n.sub) out.push(`<text x="${n.ax + PAD}" y="${n.ay + 34}" font-size="11" fill="${p["--muted"]}">${kindWord ? `<tspan font-size="9" letter-spacing="0.06em">${kindWord}</tspan>  ` : ""}${esc(trunc(n.sub, Math.max(20, Math.floor((n.w - 120) / 6.2))))}</text>`);
      else if (kindWord) out.push(`<text x="${n.ax + n.w - PAD}" y="${n.ay + 19}" text-anchor="end" font-size="9" letter-spacing="0.06em" fill="${p["--muted"]}">${kindWord}</text>`);
      out.push("</g>");
    }
    for (const c of n.children) (c.leaf ? drawLeaf : drawBox)(c, p, out);
  }
  function drawLeaf(n, p, out, o) {
    const r = n.r;
    const col = p[r.t.cat] || p["--muted"];
    const pub = (n.many || [r]).some((x) => x.publicIps && x.publicIps.length);
    const title = n.many ? `${n.label}: ${n.many.map((x) => x.name).join(", ")}` : `${r.name}\n${r.t.label}\nrg ${r.resourceGroup}${pub ? `\npublic IP ${r.publicIps.join(", ")}` : ""}`;
    out.push(`<g data-arch-node="${esc(n.key)}" class="arch-leaf"${n.context ? ' opacity="0.7"' : ""}><title>${esc(title)}</title>`);
    out.push(`<rect class="arch-leaf-bg" x="${n.ax}" y="${n.ay}" width="${LW}" height="${LH}" rx="6" fill="${p["--surface-2"]}" stroke="${p["--border-strong"]}"${n.context ? ' stroke-dasharray="3 3"' : ""}/>`);
    const ic = iconOf(r.t.abbr);
    out.push(`<rect x="${n.ax + 6}" y="${n.ay + 7}" width="32" height="32" rx="5" fill="${col}" fill-opacity="${ic ? 0.1 : 0.18}" stroke="${col}" stroke-opacity="0.6"/>`);
    const vc = arch.vmCol && arch.vmCol.get(n.key);
    if (vc) out.push(`<rect x="${n.ax + 1.5}" y="${n.ay + 6}" width="3.5" height="${LH - 12}" rx="1.75" fill="${vc}"><title>Its traffic lines have this colour</title></rect>`);
    const abbr = r.t.abbr;
    if (ic) {
      iconsUsed.add(ic[0]);
      out.push(`<use href="#az-${ic[0]}" xlink:href="#az-${ic[0]}" x="${n.ax + 10}" y="${n.ay + 11}" width="24" height="24"/>`);
    } else out.push(`<text x="${n.ax + 22}" y="${n.ay + 27}" text-anchor="middle" font-size="${abbr.length > 3 ? 8.5 : 10}" font-weight="700" fill="${col}">${esc(abbr)}</text>`);
    out.push(`<text x="${n.ax + 46}" y="${n.ay + 20}" font-size="12" font-weight="600" fill="${p["--text"]}">${esc(trunc(n.label, pub && arch.publicIps ? 17 : 21))}</text>`);
    // A firewall VM says so where the type goes, in the firewall colour.
    const fwVm = r.appliance && !n.many;
    out.push(`<text x="${n.ax + 46}" y="${n.ay + 35}" font-size="10.5"${fwVm ? ' font-weight="600"' : ""} fill="${fwVm ? p["--warning"] : p["--muted"]}">${fwVm ? "<title>Forwards traffic for others (IP forwarding, or a route's next hop): it has no traffic lines of its own</title>" : ""}${esc(trunc(n.sub, 25))}</text>`);
    if (pub && arch.publicIps) {
      out.push(`<g><title>Public IP${r.publicIps && r.publicIps.length ? ": " + esc(r.publicIps.join(", ")) : ""}</title><rect x="${n.ax + LW - 46}" y="${n.ay + 6}" width="40" height="15" rx="7.5" fill="${p["--critical"]}" fill-opacity="0.18" stroke="${p["--critical-text"]}" stroke-opacity="0.7"/><text x="${n.ax + LW - 26}" y="${n.ay + 17}" text-anchor="middle" font-size="9" font-weight="600" fill="${p["--critical-text"]}">public</text></g>`);
    }
    out.push("</g>");
  }
  let arch = {}; // the options of the drawing being drawn (read by drawLeaf)
  function anchor(a, b) {
    const ac = { x: a.ax + a.w / 2, y: a.ay + a.h / 2 }, bc = { x: b.ax + b.w / 2, y: b.ay + b.h / 2 };
    const dx = bc.x - ac.x, dy = bc.y - ac.y;
    if (Math.abs(dx) * a.h > Math.abs(dy) * a.w) return { x: dx > 0 ? a.ax + a.w : a.ax, y: ac.y, h: true };
    return { x: ac.x, y: dy > 0 ? a.ay + a.h : a.ay, h: false };
  }
  const LINK_STYLE = {
    peer: (p) => [p["--accent-text"], "", 2],
    "peer-bad": (p) => [p["--critical-text"], "6 4", 2],
    vpn: (p) => [p["--warning"], "8 4", 2],
    pe: (p) => [p["--muted"], "2 4", 1.4],
    "flow-allow": (p) => [p["--good-text"], "", 2.2],
    "flow-part": (p) => [p["--warning"], "", 2.2],
    "flow-deny": (p) => [p["--critical-text"], "", 2.2],
    "flow-unknown": (p) => [p["--muted"], "", 2],
  };
  function drawLinks(m, at, p, out) {
    // Lines that meet one side of a tile are spread along it, in the order of where they go, so they do not all
    // start from one point and cross less. Lines between the same two tiles keep the same order at both ends.
    const segs = [], sides = new Map();
    for (const l of m.links) {
      const a = at.get(l.a), b = at.get(l.b);
      if (a && b) segs.push({ l, a, b, s: anchor(a, b), e: anchor(b, a) });
    }
    segs.forEach((g, i) => {
      for (const [n, q, other] of [[g.a, g.s, g.b], [g.b, g.e, g.a]]) {
        const k = `${n.key}|${q.h ? (q.x <= n.ax ? "L" : "R") : q.y <= n.ay ? "T" : "B"}`;
        if (!sides.has(k)) sides.set(k, []);
        sides.get(k).push({ n, q, i, along: q.h ? other.ay + other.h / 2 : other.ax + other.w / 2 });
      }
    });
    for (const list of sides.values()) {
      if (list.length < 2) continue;
      list.sort((u, v) => u.along - v.along || u.i - v.i);
      const { n, q } = list[0];
      const step = Math.min(12, ((q.h ? n.h : n.w) * 0.7) / (list.length - 1));
      list.forEach((u, j) => {
        const off = (j - (list.length - 1) / 2) * step;
        if (u.q.h) u.q.y += off;
        else u.q.x += off;
      });
    }
    const traffic = m.links.some((l) => l.on);
    // Where a pill or chevron may not sit: box titles and tiles.
    const busy = [...at.values()].filter((n) => n.kind !== "root").map((n) => (n.leaf ? [n.ax, n.ay, n.w, n.h] : [n.ax, n.ay, n.w, headH(n)]));
    const free = (x, y) => !busy.some(([bx, by, bw, bh]) => x > bx - 10 && x < bx + bw + 10 && y > by - 10 && y < by + bh + 10);
    for (const { l, s, e } of segs) {
      // Ends that face each other across a narrow gap (two VNets side by side) would make the curve loop back: keep it inside the gap.
      const gap = s.h && e.h ? Math.abs(e.x - s.x) : !s.h && !e.h ? Math.abs(e.y - s.y) : Infinity;
      const bend = Math.min(Math.max(40, Math.hypot(e.x - s.x, e.y - s.y) / 3), Math.max(12, gap / 2));
      const c1 = s.h ? { x: s.x + (e.x > s.x ? bend : -bend), y: s.y } : { x: s.x, y: s.y + (e.y > s.y ? bend : -bend) };
      const c2 = e.h ? { x: e.x + (s.x > e.x ? bend : -bend), y: e.y } : { x: e.x, y: e.y + (s.y > e.y ? bend : -bend) };
      const [col0, dash0, w] = LINK_STYLE[l.kind](p);
      // With traffic lines on, the network lines (peerings, VPN, endpoints) step back.
      const op = traffic && !l.on ? 0.4 : 0.85;
      const col = l.col === "grey" ? p["--text-2"] : l.col || col0;
      const dash = l.col ? FLOW_DASH[l.flow] : l.dash ? "7 4" : dash0;
      const g = l.on ? ` class="arch-ln" data-on="${esc(l.on.join(" "))}"` : "";
      out.push(`<g${g}>`);
      out.push(`<path d="M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${e.x},${e.y}" fill="none" stroke="${col}" stroke-width="${w}" stroke-opacity="${op}"${dash ? ` stroke-dasharray="${dash}"` : ""}><title>${esc(l.title)}</title></path>`);
      if (!l.arrow) {
        out.push(`<circle cx="${s.x}" cy="${s.y}" r="3" fill="${col}"/><circle cx="${e.x}" cy="${e.y}" r="3" fill="${col}"/></g>`);
        continue;
      }
      // An arrowhead where the traffic arrives (at both ends when it goes both ways).
      const f = (v) => v.toFixed(1);
      const head = (tip, from) => {
        const ang = Math.atan2(tip.y - from.y, tip.x - from.x), L = 10, W = 5;
        const bx = tip.x - L * Math.cos(ang), by = tip.y - L * Math.sin(ang);
        const px = -Math.sin(ang) * W, py = Math.cos(ang) * W;
        return `<path d="M${f(tip.x)},${f(tip.y)} L${f(bx + px)},${f(by + py)} L${f(bx - px)},${f(by - py)} Z" fill="${col}"><title>${esc(l.title)}</title></path>`;
      };
      out.push(l.both ? head(s, c1) : `<circle cx="${s.x}" cy="${s.y}" r="3" fill="${col}"/>`);
      out.push(head(e, c2));
      // About halfway (moved along the line off titles and tiles): the number of pairs on a line to a firewall, or an
      // arrow on a long one-way line.
      const pt = (t) => {
        const u = 1 - t;
        return [u * u * u * s.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * e.x, u * u * u * s.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * e.y];
      };
      const [mx, my] = pt([0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74].find((t) => free(...pt(t))) ?? 0.5);
      if (l.trunk > 1) {
        const r = l.trunk > 9 ? 9 : 7.5;
        out.push(`<g><title>${esc(l.title)}</title><circle cx="${f(mx)}" cy="${f(my)}" r="${r}" fill="${p["--surface"]}" stroke="${col}" stroke-width="1.5"/><text x="${f(mx)}" y="${f(my + 3.3)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${p["--text"]}">${l.trunk}</text></g>`);
      } else if (!l.both && Math.hypot(e.x - s.x, e.y - s.y) > 90) {
        const dx = e.x + c2.x - c1.x - s.x, dy = e.y + c2.y - c1.y - s.y, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        out.push(`<path d="M${f(mx - 3 * ux - 4 * uy)},${f(my - 3 * uy + 4 * ux)} L${f(mx + 3 * ux)},${f(my + 3 * uy)} L${f(mx - 3 * ux + 4 * uy)},${f(my - 3 * uy - 4 * ux)}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${op}"/>`);
      }
      out.push("</g>");
    }
  }
  function render(m, o) {
    arch = o;
    measure(m.root);
    const at = new Map();
    place(m.root, 0, 0, at);
    const p = palette();
    const out = [];
    iconsUsed = new Set();
    drawBox(m.root, p, out);
    drawLinks(m, at, p, out);
    return { svg: iconDefs() + out.join(""), w: m.root.w, h: m.root.h, at, p };
  }

  /* --- the page --- */
  function stats(all, t) {
    const a = inventory(t);
    if (!a || !a.data) return "";
    const d = a.data;
    const main = d.resources.filter((r) => r.t.cat !== "support");
    const pub = d.resources.filter((r) => r.publicIps && r.publicIps.length).length;
    return (
      statTile({ label: "Subscriptions", value: fmt.int(d.subscriptions.length), delta: d.tenants.length > 1 ? `${fmt.int(d.tenants.length)} tenants` : "" }) +
      statTile({ label: "Resource groups", value: fmt.int(d.groups.size) }) +
      statTile({ label: "Virtual networks", value: fmt.int(d.vnets.length), delta: `${fmt.int(d.vnets.reduce((n, v) => n + v.subnets.length, 0))} subnets` }) +
      statTile({ label: "Resources", value: fmt.int(main.length), delta: `${fmt.int(d.resources.length - main.length)} supporting (disks, NSGs, alerts…)` }) +
      statTile({ label: "With a public IP", value: fmt.int(pub), deltaCls: pub ? "bad" : "" })
    );
  }
  function extra() {
    for (const sel of ["#scan-sub", "#scan-fw", "#scan-new", "#scan-csv", "#scan-accepted"]) $(sel).classList.add("hidden");
    $("#scan-q").placeholder = "Find on the drawing";
    const h2 = $("#scan-count").parentElement;
    if (h2 && h2.firstChild && h2.firstChild.nodeType === 3) h2.firstChild.textContent = "Drawing ";
    return "";
  }

  function scopePanel(inv, o) {
    const subs = new Map();
    for (const g of inv.groups.values()) {
      const k = `${g.tenant}|${g.subscriptionId}`;
      if (!subs.has(k)) subs.set(k, { key: k, tenant: g.tenant, name: inv.subName.get(k) || g.subscriptionId, groups: [] });
      subs.get(k).groups.push(g);
    }
    const list = [...subs.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const multi = inv.tenants.length > 1;
    const rows = list
      .map((s) => {
        s.groups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        const on = s.groups.filter((g) => o.scope.has(g.key)).length;
        const hit = (g) => !o.find || g.name.includes(o.find);
        const any = s.groups.some(hit);
        const open = o.open.has(s.key) || (o.find && any);
        const groups = s.groups
          .map(
            (g) =>
              `<div class="arch-rgrow${o.openRg.has(g.key) ? " open" : ""}${hit(g) ? "" : " hidden"}">${g.count ? `<button type="button" class="arch-rgopen" data-arch-rgopen="${esc(g.key)}" title="Pick single resources">${icon("chevron")}</button>` : '<span class="arch-rgopen"></span>'}<label class="arch-rg${g.count || g.vnets ? "" : " empty"}" data-arch-name="${esc(g.name)}"><input type="checkbox" data-arch-rg="${esc(g.key)}"${o.scope.has(g.key) ? " checked" : ""}/><span class="arch-rg-name">${esc(g.displayName)}</span>${g.vnets ? '<span class="arch-net" title="Holds a virtual network">VNet</span>' : ""}<span class="n">${resCount(inv, o, g)}</span></label></div>${o.openRg.has(g.key) ? resRows(inv, o, g) : ""}`
          )
          .join("");
        return `<div class="arch-sub${open ? " open" : ""}${any ? "" : " hidden"}" data-arch-subrow="${esc(s.key)}">
          <div class="arch-sub-head"><input type="checkbox" data-arch-sub="${esc(s.key)}"${on && on === s.groups.length ? " checked" : ""}${on && on < s.groups.length ? ' data-partial="1"' : ""}/><button type="button" class="arch-sub-name" data-arch-open="${esc(s.key)}">${icon("chevron")}<span>${esc(s.name)}</span>${multi ? `<small>${esc(inv.tenantName.get(s.tenant) || s.tenant)}</small>` : ""}</button><span class="n">${on ? `${fmt.int(on)}/` : ""}${fmt.int(s.groups.length)}</span></div>
          <div class="arch-rgs">${groups}</div>
        </div>`;
      })
      .join("");
    return `<aside class="arch-pick">
      <div class="arch-pick-head"><b>What to draw</b><span><button type="button" class="link-btn" data-arch-act="all">All</button> · <button type="button" class="link-btn" data-arch-act="none">None</button></span></div>
      <input class="input" type="search" placeholder="Find a resource group" data-arch-find value="${esc(o.find)}"/>
      <p class="arch-hint">Pick resource groups. The networks their resources sit in are drawn by themselves.</p>
      <div class="arch-subs">${rows || '<div class="muted small">No resource groups found.</div>'}</div>
    </aside>`;
  }
  // Resources of a group to tick one by one (supporting ones like disks stay with what they belong to).
  const groupRes = (inv, g) => inv.resources.filter((r) => rgKey(r) === g.key && r.t.cat !== "support" && r.type !== "microsoft.network/networkinterfaces" && r.type !== "microsoft.network/publicipaddresses");
  function resCount(inv, o, g) {
    const own = (o.pick.size || o.hide.size) && groupRes(inv, g);
    const out = own ? own.filter((r) => o.hide.has(r.id)).length : 0;
    const extra = own ? own.filter((r) => o.pick.has(r.id)).length : 0;
    return o.scope.has(g.key) && out ? `${fmt.int(g.count - out)}/${fmt.int(g.count)}` : !o.scope.has(g.key) && extra ? `${fmt.int(extra)}/${fmt.int(g.count)}` : fmt.int(g.count);
  }
  function resRows(inv, o, g) {
    const rs = groupRes(inv, g).sort((a, b) => a.t.label.localeCompare(b.t.label) || a.name.localeCompare(b.name));
    const on = (r) => !o.hide.has(r.id) && (o.scope.has(g.key) || o.pick.has(r.id) || (o.drawn && o.drawn.has(r.id)));
    return `<div class="arch-res">${rs.map((r) => `<label class="arch-rg" title="${esc(r.t.label)}"><input type="checkbox" data-arch-res="${esc(r.id)}" data-arch-resrg="${esc(g.key)}"${on(r) ? " checked" : ""}/><span class="arch-rg-name">${esc(r.name)}</span><span class="n">${esc(r.appliance ? "firewall VM" : r.t.label)}</span></label>`).join("")}</div>`;
  }
  function toolbar(o, m) {
    const chk = (k, label, title) => `<label class="arch-opt" title="${esc(title)}"><input type="checkbox" data-arch-opt="${k}"${o[k] ? " checked" : ""}/> ${esc(label)}</label>`;
    const net = o.layout !== "groups";
    const lay = (k, label, title) => `<button type="button" data-arch-layout="${k}" class="${o.layout === k ? "active" : ""}" title="${esc(title)}">${label}</button>`;
    return `<div class="arch-bar">
      <div class="seg">${lay("hubs", "Hub and spoke", "Each hub VNet in the middle, its peered spokes around it, on-premises on the left")}${lay("network", "Network", "VNets with their subnets, packed in rows")}${lay("groups", "Resource groups", "Subscription, resource group, resource")}</div>
      <div class="arch-opts">
        ${net ? chk("peerings", "Peerings", "Lines between peered VNets (red: not connected or one side only)") + chk("onprem", "On-premises", "VPN and ExpressRoute sites and their connections") + chk("peLinks", "Private endpoint links", "A dotted line from each private endpoint to what it opens") + chk("wholeVnets", "Whole VNets", "Every subnet of each VNet drawn, also those with nothing picked in them") : chk("subs", "Subscription boxes", "Group the resource groups by subscription")}
        ${chk("publicIps", "Public IPs", "Mark resources that have a public IP")}
        ${o.hasFwVms ? chk("fwVms", "Firewall VMs", "VMs that forward traffic for others (Palo Alto, Fortinet...). Left out, traffic through them is drawn straight, dashed") : ""}
        <select class="select" data-arch-grouped title="One tile per resource, or one per type in each box">
          <option value="auto"${o.grouped === "auto" ? " selected" : ""}>Tiles: automatic</option>
          <option value="each"${o.grouped === "each" ? " selected" : ""}>One per resource</option>
          <option value="type"${o.grouped === "type" ? " selected" : ""}>One per type</option>
        </select>
      </div>
    </div>
    <div class="arch-bar arch-traffic">
      <select class="select" data-arch-traffic title="Lines that show whether traffic gets through, following routes, NSGs and firewall network rules">
        ${TRAFFIC.map(([k, label]) => `<option value="${k}"${o.traffic === k ? " selected" : ""}>${esc(label)}</option>`).join("")}
      </select>
      ${o.traffic === "custom" ? `<input class="input" data-arch-ports placeholder="443, tcp 8080-8090, udp 53" value="${esc(o.ports)}" title="Ports, comma separated; tcp is assumed without a protocol"/>` : ""}
      ${o.traffic ? `<div class="seg" title="What the line colour shows"><button type="button" data-arch-fcol="vm" class="${o.flowColor === "vm" ? "active" : ""}" title="Each VM's lines in its own colour; solid gets through, dashed some ports, dotted blocked">Colour by VM</button><button type="button" data-arch-fcol="state" class="${o.flowColor === "state" ? "active" : ""}" title="Green gets through, yellow some ports, red blocked">By result</button></div>` : ""}
      ${o.traffic && !o.sel ? `<label class="arch-opt" title="Pairs where nothing gets through (most are on purpose)"><input type="checkbox" data-arch-opt="flowBlocked"${o.flowBlocked ? " checked" : ""}/> Show blocked</label><label class="arch-opt" title="Pairs of VMs in the same subnet (they nearly always reach each other)"><input type="checkbox" data-arch-opt="flowSame"${o.flowSame ? " checked" : ""}/> Same subnet</label><span class="arch-hint">Point at a VM to light up its lines; click it to see only its traffic</span>` : ""}
      ${o.traffic && o.sel ? `<div class="seg"><button type="button" data-arch-dir="in" class="${o.dir === "in" ? "active" : ""}" title="Can the other drawn VMs reach the tile you click?">Into the picked tile</button><button type="button" data-arch-dir="out" class="${o.dir === "out" ? "active" : ""}" title="Can the tile you click reach the other drawn VMs?">Out of it</button></div>` : ""}
    </div>
    <div class="arch-cats">${CATS.map(([c, label]) => `<button type="button" class="chip${o.cats.has(c) ? " active" : ""}" data-arch-cat="${c}"><span class="arch-dot" style="background:var(${CATS.find((x) => x[0] === c)[2]})"></span>${esc(label)}</button>`).join("")}</div>`;
  }
  function page(all, t) {
    const a = inventory(t);
    if (!a) return `<div class="empty-state">Loading the saved drawing…</div>`;
    if (a.error) return `<div class="empty-state big"><h3>Could not load the drawing</h3><p class="muted">${esc(a.error)}</p></div>`;
    const inv = a.data;
    if (!inv.updatedAt) return `<div class="empty-state big"><h3>Nothing saved yet</h3><p>Each scan saves what it found. Run it once${canRun("architecture") ? " (Run now above)" : ""} and the drawing shows here.</p></div>`;
    const o = opts(t, inv);
    const last = o.traffic && t.archFlow && t.archFlow.results;
    o.through = new Set(last ? last.map((r) => r.fw || r.hop).filter((id) => id && !o.hide.has(id) && (o.fwVms || !(inv.byId.get(id) || {}).appliance)) : []);
    o.hasFwVms = inv.resources.some((r) => r.appliance);
    loadIcons();
    const m = model(inv, o);
    o.drawn = new Set(drawnLeaves(m.root).flatMap((l) => (l.many || [l.r]).map((r) => r.id)));
    const flow = trafficFor(t, m, o);
    flowLinks(m, flow, o);
    t.archModel = m;
    let canvas;
    if (!o.scope.size && !o.pick.size) canvas = `<div class="empty-state big"><h3>Pick what to draw</h3><p>Tick resource groups or whole subscriptions on the left.</p></div>`;
    else if (!m.leaves && !m.root.children.length) canvas = `<div class="empty-state">Nothing to draw: the picked resource groups have nothing of the kinds switched on above.</div>`;
    else {
      const d = render(m, o);
      t.archDrawn = d;
      const view = o.view || fit(d);
      o.view = view;
      const find = t.filters.q;
      canvas = `<div class="arch-canvas" id="arch-canvas">
        <svg id="arch-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" font-family="${esc(d.p["--font"])}"><g id="arch-vp" transform="translate(${view.x},${view.y}) scale(${view.k})">${d.svg}</g></svg>
        <div class="arch-zoom">
          <button type="button" class="btn" data-arch-act="in" title="Zoom in">${icon("plus")}</button>
          <button type="button" class="btn" data-arch-act="out" title="Zoom out">${icon("minus")}</button>
          <button type="button" class="btn" data-arch-act="fit" title="Fit the drawing">Fit</button>
        </div>
        <div class="arch-export">
          <button type="button" class="btn" data-arch-act="svg" title="Download as SVG">${icon("download")} SVG</button>
          <button type="button" class="btn" data-arch-act="png" title="Download as a picture">${icon("download")} PNG</button>
          <button type="button" class="btn" data-arch-act="drawio" title="Download a draw.io file you can edit (diagrams.net, Visio import)">${icon("download")} draw.io</button>
        </div>
      </div>
      <div class="arch-legend">
        ${m.grouped ? "<span>One tile per type (many resources). Switch Tiles to One per resource to see each.</span>" : ""}
        <span><i class="ln peer"></i>peering</span><span><i class="ln bad"></i>peering not connected</span><span><i class="ln vpn"></i>VPN / ExpressRoute</span><span><i class="ln pe"></i>private endpoint</span>
        ${o.traffic && o.flowColor === "vm" ? `<span><i class="ln vmc"></i>traffic, in the colour of the VM it comes from (stripe on its tile)</span><span><i class="ln vmc part"></i>some ports open</span><span><i class="ln vmc no"></i>blocked or unknown</span>` : ""}
        ${o.traffic && o.flowColor !== "vm" ? `<span><i class="ln ok"></i>traffic gets through</span><span><i class="ln part"></i>some ports open</span><span><i class="ln no"></i>blocked</span><span><i class="ln fwl"></i>through a firewall</span>` : ""}
        ${o.traffic && m.links.some((l) => l.trunk > 1) ? `<span><i class="arch-count">3</i>pairs on one line through the firewall (click a VM to see each)</span>` : ""}
        ${o.traffic && o.flowColor === "vm" && m.links.some((l) => l.col === "grey") ? `<span><i class="ln grey"></i>into a tile that sends nothing itself</span>` : ""}
        ${o.hasFwVms && o.fwVms ? `<span><b class="arch-fwvm">Firewall VM</b>: forwards traffic for others, no lines of its own</span>` : ""}
        ${o.traffic && flow && flow.loading ? "<span>Checking traffic…</span>" : ""}
        <span>Dashed tile: in a network you picked, from a resource group you did not</span>
        <span>Drag to move, wheel to zoom, click a tile for details</span>
      </div>
      <div id="arch-detail">${detail(inv, o, find)}${trafficTable(inv, o, flow)}</div>`;
    }
    const note = `<div class="note">Saved by the scan ${esc(fmt.rel(inv.updatedAt))}.${inv.truncated ? " Only the first 20,000 resources per tenant were read." : ""} A resource sits in the subnet of its first NIC or IP configuration; App Service apps sit in the subnet of their VNet integration.</div>`;
    requestAnimationFrame(() => afterRender(t));
    return `<div class="arch-wrap">${scopePanel(inv, o)}<div class="arch-main">${toolbar(o, m)}${canvas}</div></div>${note}`;
  }
  function fit(d) {
    const el = $("#arch-canvas");
    const W = el ? el.clientWidth : 1000, H = el ? el.clientHeight : 620;
    const k = Math.min(1.2, (W - 32) / d.w, (H - 70) / d.h);
    return { k, x: (W - d.w * k) / 2, y: Math.max(16, (H - d.h * k) / 2), W };
  }
  function afterRender(t) {
    const o = t.archOpts;
    if (!o) return;
    const list = $(".arch-subs");
    if (list && o.scroll) list.scrollTop = o.scroll;
    for (const el of document.querySelectorAll("[data-partial]")) el.indeterminate = true;
    // The first draw knew no canvas size, and a turned phone or a resized window has another: fit again.
    const canvas = $("#arch-canvas");
    if (canvas && o.view && o.view.W !== canvas.clientWidth) o.refit = true;
    if (o.refit && t.archDrawn && canvas) {
      o.refit = false;
      o.view = fit(t.archDrawn);
      applyView(o);
    }
    markFind(t);
    markSel(o);
  }
  function applyView(o) {
    const vp = $("#arch-vp");
    if (vp) vp.setAttribute("transform", `translate(${o.view.x},${o.view.y}) scale(${o.view.k})`);
  }
  function markFind(t) {
    const q = t.filters.q;
    const svg = $("#arch-svg");
    if (!svg) return;
    svg.classList.toggle("finding", !!q);
    for (const g of svg.querySelectorAll("[data-arch-node]")) {
      const n = t.archDrawn.at.get(g.dataset.archNode);
      const hit = q && n && (n.many || [n.r]).some((r) => `${r.name} ${r.t.label} ${r.resourceGroup} ${(r.publicIps || []).join(" ")}`.toLowerCase().includes(q));
      g.classList.toggle("hit", !!hit);
    }
  }
  function markSel(o) {
    for (const g of document.querySelectorAll("#arch-svg [data-arch-node]")) g.classList.toggle("sel", g.dataset.archNode === o.sel);
  }
  function detail(inv, o) {
    const t = toolState(ID);
    const n = o.sel && t.archDrawn && t.archDrawn.at.get(o.sel);
    if (!n) return "";
    const portal = (id) => `https://portal.azure.com/#resource${id}`;
    if (n.many) {
      return `<div class="arch-detail"><b>${esc(n.label)}</b><ul>${n.many.slice(0, 100).map((r) => `<li><a href="${esc(portal(r.id))}" target="_blank" rel="noopener">${esc(r.name)}</a> <span class="muted">rg ${esc(r.resourceGroup)}</span></li>`).join("")}</ul></div>`;
    }
    const r = n.r;
    const at = r.subnet && inv.subnetById.get(r.subnet);
    const target = r.type === "microsoft.network/privateendpoints" && r.link ? inv.byId.get(r.link.split("/").slice(0, 9).join("/")) : null;
    const rows = [
      ["Type", `${r.t.label}${r.kind ? ` <span class="muted">(${esc(r.kind)})</span>` : ""}${r.sku ? ` · ${esc(r.sku)}` : ""}`],
      ["Resource group", esc(r.resourceGroup)],
      ["Subscription", esc(inv.subName.get(`${r.tenant}|${r.subscriptionId}`) || r.subscriptionId)],
      ["Location", esc(r.location || "")],
      at ? ["Network", `${esc(at.v.name)} › ${esc(at.s.name)} <span class="mono">${esc(at.s.prefixes.join(", "))}</span>`] : null,
      r.subnetOutside ? ["Network", `a subnet this scan cannot read: <span class="mono">${esc(r.subnet)}</span>`] : null,
      r.publicIps ? ["Public IP", r.publicIps.map((x) => `<span class="mono">${esc(x)}</span>`).join(", ")] : null,
      r.mgmtIps ? ["Management IP", `${r.mgmtIps.map((x) => `<span class="mono">${esc(x)}</span>`).join(", ")} <span class="muted">(Azure manages it through this; it takes no traffic)</span>`] : null,
      r.link && r.type === "microsoft.network/privateendpoints" ? ["Opens", target ? `${esc(target.name)} <span class="muted">${esc(target.t.label)}</span>` : `<span class="mono">${esc(r.link.split("/").slice(0, 9).join("/"))}</span>`] : null,
    ].filter(Boolean);
    return `<div class="arch-detail"><div class="arch-detail-head"><b>${esc(r.name)}</b><a href="${esc(portal(r.id))}" target="_blank" rel="noopener">Open in the Azure portal</a></div><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>`;
  }

  function trafficTable(inv, o, f) {
    if (!o.traffic || !f) return "";
    if (f.auto && f.results) {
      const n = (s) => f.results.filter((r) => r.state === s).length;
      const parts = [["allow", "open"], ["part", "partly open"], ["deny", "blocked"], ["unknown", "unknown"]].filter(([s]) => n(s)).map(([s, w]) => `<span class="flow-state ${s}">${n(s)} ${w}</span>`).join(" ");
      const notes = [f.capped && "Only the first 6,000 pairs were checked: pick fewer resource groups, or click a VM", f.missing, f.note].filter(Boolean).map((x) => `<p class="arch-hint">${esc(x)}</p>`).join("");
      return `<div class="arch-detail arch-flow"><div class="arch-detail-head"><b>Traffic between the drawn VMs</b><span class="muted">${esc((f.checks || []).join(", "))}</span></div>${notes}<p>${f.results.length} pairs checked: ${parts || "none"}${!o.flowBlocked && n("deny") ? " (blocked ones are not drawn; tick Show blocked)" : ""}${f.sameLeft ? `; ${f.sameLeft} in the same subnet are not drawn (tick Same subnet)` : ""}.</p><p class="arch-hint">Hover a line for its ports and rules; click a VM for the full table of its traffic.</p></div>`;
    }
    if (f.quiet) return `<div class="arch-detail arch-flow"><span class="muted">${esc(f.quiet)}</span></div>`;
    if (f.loading) return `<div class="arch-detail arch-flow"><span class="muted">Checking traffic…</span></div>`;
    if (f.error) return `<div class="arch-detail arch-flow"><span style="color:var(--critical-text)">${esc(f.error)}</span></div>`;
    const name = (id) => (inv.byId.get(id) || {}).name || id.split("/").pop();
    const order = { deny: 0, part: 1, unknown: 2, allow: 3, none: 4 };
    const other = (r) => name(o.dir === "in" ? r.from : r.to);
    const unknown = f.results.filter((r) => r.state === "none").map(other);
    const rows = f.results.filter((r) => r.state !== "none").sort((a, b) => order[a.state] - order[b.state] || name(o.dir === "in" ? a.from : a.to).localeCompare(name(o.dir === "in" ? b.from : b.to)));
    const ports = (r) => {
      if (r.state === "none" || !r.checks) return esc(r.why || "");
      if (r.state === "deny" && r.why) return esc(r.why);
      const bad = r.checks.filter((c) => c.ok !== "all");
      const good = r.checks.filter((c) => c.ok === "all");
      const fwRules = [...new Set(good.map((c) => c.rule).filter(Boolean))];
      const parts = [];
      // One line per reason: "DNS TCP 53, LDAP TCP 389: subnet snet-dc: deny-dev".
      const why = new Map();
      for (const c of bad) {
        const k = c.by || "";
        if (!why.has(k)) why.set(k, []);
        why.get(k).push(`${c.label}${c.ok === "part" ? " (partly)" : ""}`);
      }
      if (bad.length) parts.push([...why].map(([by, labels]) => `<div><b>${bad.length === r.checks.length && why.size === 1 && bad.every((c) => c.ok === "none") ? "all blocked" : esc(labels.join(", "))}</b>${by ? ` <span class="muted">${esc(by)}</span>` : ""}</div>`).join(""));
      const opens = bad.filter((c) => c.open);
      if (opens.length) parts.push(opens.map((c) => `<div class="muted">${esc(c.label)} open: ${esc(c.open)}</div>`).join(""));
      if (good.length && bad.length) parts.push(`<div class="muted" title="${esc(good.map((c) => c.label).join(", "))}">${good.length} of ${r.checks.length} open</div>`);
      else if (good.length) parts.push(`<div class="muted">all ${good.length} open</div>`);
      if (fwRules.length) parts.push(`<div class="muted">firewall rule${fwRules.length > 1 ? "s" : ""}: ${esc(fwRules.join(", "))}</div>`);
      return parts.join("");
    };
    const body = rows
      .map((r) => `<tr><td><span class="primary">${esc(name(r.from))}</span> → <span class="primary">${esc(name(r.to))}</span></td><td><span class="flow-state ${r.state}">${FLOW_WORD[r.state]}</span></td><td title="${esc((r.steps || []).join("\n"))}">${esc(r.via || "")}${r.steps && r.steps.length ? `<div class="secondary">${esc(r.steps.join(" › "))}</div>` : ""}</td><td>${ports(r)}</td></tr>`)
      .join("");
    const notes = [f.missing, f.note, unknown.length && `No private address saved for ${unknown.join(", ")}`].filter(Boolean).map((x) => `<p class="arch-hint">${esc(x)}</p>`).join("");
    return `<div class="arch-detail arch-flow"><div class="arch-detail-head"><b>Traffic ${o.dir === "in" ? "into" : "out of"} the picked tile</b><span class="muted">${esc(f.checks.join(", "))}</span></div>${notes}<div class="table-wrap"><table class="data"><thead><tr><th>From → to</th><th>Result</th><th>Path</th><th>Blocked ports and rules</th></tr></thead><tbody>${body || '<tr><td colspan="4" class="muted">Nothing to check.</td></tr>'}</tbody></table></div><p class="arch-hint">Follows routes, NSGs (also on NICs, with ASGs) and firewall network rules, classic rules too. Application rules (FQDNs), service tags other than VirtualNetwork and Internet, and VPN gateways are not followed.</p></div>`;
  }

  /* --- downloads --- */
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  function svgFile(d) {
    const m = 24;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${d.w + 2 * m}" height="${d.h + 2 * m}" viewBox="${-m} ${-m} ${d.w + 2 * m} ${d.h + 2 * m}" font-family="${esc(d.p["--font"])}"><rect x="${-m}" y="${-m}" width="${d.w + 2 * m}" height="${d.h + 2 * m}" fill="${d.p["--bg"]}"/>${d.svg}</svg>`;
  }
  const fileName = (ext) => `architecture-${new Date().toISOString().slice(0, 10)}.${ext}`;
  function downloadPng(d) {
    const text = svgFile(d);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    img.onload = () => {
      const m = 48, W = d.w + m, H = d.h + m;
      const k = Math.min(2, 16000 / Math.max(W, H), Math.sqrt(200e6 / (W * H)));
      const c = document.createElement("canvas");
      c.width = Math.round(W * k);
      c.height = Math.round(H * k);
      const ctx = c.getContext("2d");
      ctx.scale(k, k);
      ctx.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      c.toBlob((b) => b && download(fileName("png"), b), "image/png");
    };
    img.src = url;
  }
  // draw.io: boxes as containers (positions relative to their box), tiles inside, lines between them. Light colours,
  // as diagrams usually go into documents.
  function drawioFile(m, d) {
    const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    const ids = new Map();
    let next = 2;
    const catCol = { compute: "#3987e5", web: "#9085e9", data: "#199e70", network: "#c98500", security: "#d55181", monitor: "#d95926", other: "#6b7380", support: "#6b7380" };
    const boxCol = { tenant: ["#ffffff", "#666666"], sub: ["#ffffff", "#888888"], rg: ["#f7f7f7", "#999999"], vnet: ["#eef5fd", "#3987e5"], subnet: ["#ffffff", "#3987e5"], onprem: ["#fff8e6", "#c98500"] };
    const walk = (n, parent) => {
      for (const c of n.children) {
        const id = `n${next++}`;
        ids.set(c.key, id);
        const geo = `<mxGeometry x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" as="geometry"/>`;
        if (c.leaf) {
          const col = catCol[c.r.t.cat] || "#6b7380";
          const label = `<b>${esc(c.label)}</b><br><font color="#666666" style="font-size:10px">${esc(c.sub)}</font>`;
          const ic = iconOf(c.r.t.abbr);
          cells.push(`<mxCell id="${id}" value="${esc(label)}" style="rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${col};strokeWidth=1.5;align=left;spacingLeft=${ic ? 44 : 10};fontSize=11;${c.context ? "dashed=1;" : ""}" vertex="1" parent="${parent}">${geo}</mxCell>`);
          if (ic) cells.push(`<mxCell id="${id}i" value="" style="image;aspect=fixed;html=1;points=[];image=img/lib/azure2/${ic[1]};" vertex="1" parent="${id}"><mxGeometry x="9" y="${(c.h - 28) / 2}" width="28" height="28" as="geometry"/></mxCell>`);
        } else {
          const [fill, stroke] = boxCol[c.kind] || ["#ffffff", "#999999"];
          const tags = c.tags.map(([t]) => t).join(" · ");
          const label = `<b>${esc(c.label)}</b>${tags ? ` <font color="#888888" style="font-size:9px">${esc(tags)}</font>` : ""}${c.sub ? `<br><font color="#777777" style="font-size:10px">${esc(c.sub)}</font>` : ""}`;
          const dashed = c.kind === "sub" || c.kind === "subnet" || c.kind === "onprem" ? "dashed=1;" : "";
          cells.push(`<mxCell id="${id}" value="${esc(label)}" style="rounded=1;arcSize=2;absoluteArcSize=1;whiteSpace=wrap;html=1;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=2;fontSize=12;fillColor=${fill};strokeColor=${stroke};${dashed}" vertex="1" parent="${parent}">${geo}</mxCell>`);
          walk(c, id);
        }
      }
    };
    walk(m.root, "1");
    const edgeCol = { peer: "#3987e5", "peer-bad": "#d03b3b", vpn: "#c98500", pe: "#888888", "flow-allow": "#0ca30c", "flow-part": "#c98500", "flow-deny": "#d03b3b", "flow-unknown": "#888888" };
    for (const l of m.links) {
      if (!ids.has(l.a) || !ids.has(l.b)) continue;
      const fd = l.col && FLOW_DASH[l.flow];
      const dash = l.col ? (fd ? `dashed=1;dashPattern=${fd};` : "") : l.arrow ? (l.dash ? "dashed=1;" : "") : l.kind === "peer" ? "" : "dashed=1;";
      cells.push(`<mxCell id="e${next++}" value="${l.arrow ? esc(l.title) : ""}" style="${l.arrow ? `endArrow=block;endFill=1;${l.both ? "startArrow=block;startFill=1;" : ""}noLabel=1;` : "endArrow=none;"}html=1;curved=1;strokeWidth=${l.kind === "pe" ? 1 : 2};strokeColor=${l.col || edgeCol[l.kind]};${dash}" edge="1" parent="1" source="${ids.get(l.a)}" target="${ids.get(l.b)}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
    }
    return `<mxfile host="azure-ops-dashboard"><diagram name="Architecture" id="arch"><mxGraphModel dx="${Math.round(d.w)}" dy="${Math.round(d.h)}" grid="0" gridSize="10" guides="1" page="0" math="0" shadow="0"><root>${cells.join("")}</root></mxGraphModel></diagram></mxfile>`;
  }

  /* --- events --- */
  const changed = (t, refit = true) => {
    const o = t.archOpts;
    saveOpts(o);
    if (refit) {
      o.view = null;
      o.refit = true;
    }
    rerender();
  };
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el.closest || !el.closest("#page-scan .arch-wrap")) return;
    const t = toolState(ID);
    const o = t.archOpts;
    const inv = t.arch && t.arch.data;
    if (!o || !inv) return;
    if (el.dataset.archRes) {
      const id = el.dataset.archRes;
      if (el.checked) {
        o.hide.delete(id);
        if (!o.scope.has(el.dataset.archResrg)) o.pick.add(id);
      } else {
        o.pick.delete(id);
        o.hide.add(id);
      }
      return changed(t);
    }
    if (el.dataset.archRg) {
      // A whole group ticked or unticked starts over: its single picks and left-outs go.
      for (const r of inv.resources) if (rgKey(r) === el.dataset.archRg) (o.pick.delete(r.id), o.hide.delete(r.id));
      if (el.checked) o.scope.add(el.dataset.archRg);
      else o.scope.delete(el.dataset.archRg);
    } else if (el.dataset.archSub) {
      for (const g of inv.groups.values()) if (`${g.tenant}|${g.subscriptionId}` === el.dataset.archSub) el.checked ? o.scope.add(g.key) : o.scope.delete(g.key);
    } else if (el.dataset.archOpt) {
      o[el.dataset.archOpt] = el.checked;
    } else if (el.dataset.archGrouped !== undefined) {
      o.grouped = el.value;
    } else if (el.dataset.archTraffic !== undefined) {
      o.traffic = el.value;
      return changed(t, false);
    } else if (el.dataset.archPorts !== undefined) {
      o.ports = el.value;
      return changed(t, false);
    } else return;
    o.sel = null;
    changed(t);
  });
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.archFind !== undefined) {
      const o = toolState(ID).archOpts;
      if (!o) return;
      o.find = el.value.trim().toLowerCase();
      // Filter in place: no redraw while typing.
      for (const sub of document.querySelectorAll(".arch-sub")) {
        let any = false;
        for (const row of sub.querySelectorAll(".arch-rgrow")) {
          const hit = !o.find || row.querySelector("[data-arch-name]").dataset.archName.includes(o.find);
          row.classList.toggle("hidden", !hit);
          if (row.nextElementSibling && row.nextElementSibling.classList.contains("arch-res")) row.nextElementSibling.classList.toggle("hidden", !hit);
          any = any || hit;
        }
        sub.classList.toggle("hidden", !any);
        sub.classList.toggle("open", !!o.find && any ? true : o.open.has(sub.dataset.archSubrow));
      }
    }
  });
  document.addEventListener("scroll", (e) => {
    if (e.target.classList && e.target.classList.contains("arch-subs")) {
      const o = toolState(ID).archOpts;
      if (o) o.scroll = e.target.scrollTop;
    }
  }, true);
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-arch-act],[data-arch-layout],[data-arch-cat],[data-arch-open],[data-arch-rgopen],[data-arch-dir],[data-arch-fcol]");
    if (!el || !el.closest("#page-scan")) return;
    const t = toolState(ID);
    const o = t.archOpts;
    const inv = t.arch && t.arch.data;
    if (!o || !inv) return;
    if (el.dataset.archRgopen) {
      const k = el.dataset.archRgopen;
      if (o.openRg.has(k)) o.openRg.delete(k);
      else o.openRg.add(k);
      return rerender();
    }
    if (el.dataset.archOpen) {
      const k = el.dataset.archOpen;
      if (o.open.has(k)) o.open.delete(k);
      else o.open.add(k);
      el.closest(".arch-sub").classList.toggle("open", o.open.has(k));
      return;
    }
    if (el.dataset.archFcol) {
      o.flowColor = el.dataset.archFcol;
      saveOpts(o);
      return rerender();
    }
    if (el.dataset.archDir) {
      o.dir = el.dataset.archDir;
      return changed(t, false);
    }
    if (el.dataset.archLayout) {
      o.layout = el.dataset.archLayout;
      o.sel = null;
      return changed(t);
    }
    if (el.dataset.archCat) {
      const c = el.dataset.archCat;
      if (o.cats.has(c)) o.cats.delete(c);
      else o.cats.add(c);
      return changed(t);
    }
    const act = el.dataset.archAct;
    if (act === "all" || act === "none") {
      // All picks what the finder shows.
      for (const g of inv.groups.values()) {
        if (o.find && !g.name.includes(o.find)) continue;
        if (act === "all") o.scope.add(g.key);
        else o.scope.delete(g.key);
      }
      o.sel = null;
      return changed(t);
    }
    const d = t.archDrawn;
    if (!d) return;
    if (act === "fit") {
      o.view = fit(d);
      return applyView(o);
    }
    if (act === "in" || act === "out") return zoomAt(o, act === "in" ? 1.25 : 0.8);
    if (act === "svg") return download(fileName("svg"), new Blob([svgFile(d)], { type: "image/svg+xml" }));
    if (act === "png") return downloadPng(d);
    if (act === "drawio") return download(fileName("drawio"), new Blob([drawioFile(t.archModel, d)], { type: "application/xml" }));
  });
  function zoomAt(o, f, cx, cy) {
    const el = $("#arch-canvas");
    if (!el || !o.view) return;
    if (cx === undefined) {
      cx = el.clientWidth / 2;
      cy = el.clientHeight / 2;
    }
    const k = Math.min(4, Math.max(0.05, o.view.k * f));
    const r = k / o.view.k;
    o.view = { ...o.view, k, x: cx - (cx - o.view.x) * r, y: cy - (cy - o.view.y) * r };
    applyView(o);
  }
  document.addEventListener(
    "wheel",
    (e) => {
      const svg = e.target.closest && e.target.closest("#arch-svg");
      if (!svg) return;
      e.preventDefault();
      const o = toolState(ID).archOpts;
      const box = svg.getBoundingClientRect();
      zoomAt(o, Math.exp(-e.deltaY * 0.0015), e.clientX - box.left, e.clientY - box.top);
    },
    { passive: false }
  );
  // Pointing at a tile lights up its traffic lines and fades the rest.
  let hot = null;
  const light = (key) => {
    if (key === hot) return;
    hot = key;
    const svg = $("#arch-svg");
    if (!svg) return;
    const lines = [...svg.querySelectorAll(".arch-ln")];
    const mine = new Set(key ? lines.filter((g) => g.dataset.on.split(" ").includes(key)) : []);
    svg.classList.toggle("arch-hl", mine.size > 0);
    for (const g of lines) g.classList.toggle("on", mine.has(g));
  };
  document.addEventListener("pointerover", (e) => {
    if (drag && drag.moved) return;
    const node = e.target.closest && e.target.closest("#arch-svg [data-arch-node]");
    light(node ? node.dataset.archNode : null);
  });
  let drag = null;
  document.addEventListener("pointerdown", (e) => {
    const svg = e.target.closest && e.target.closest("#arch-svg");
    if (!svg || e.button !== 0) return;
    const o = toolState(ID).archOpts;
    drag = { x: e.clientX, y: e.clientY, vx: o.view.x, vy: o.view.y, moved: false, target: e.target };
    svg.setPointerCapture(e.pointerId);
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const o = toolState(ID).archOpts;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    o.view = { ...o.view, x: drag.vx + dx, y: drag.vy + dy };
    applyView(o);
  });
  document.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) return;
    // A click: select the tile under it (or clear).
    const t = toolState(ID);
    const o = t.archOpts;
    const node = d.target.closest && d.target.closest("[data-arch-node]");
    o.sel = node ? node.dataset.archNode : null;
    if (o.traffic) return rerender(); // the lines change with the pick
    markSel(o);
    const box = $("#arch-detail");
    if (box && t.arch && t.arch.data) box.innerHTML = detail(t.arch.data, o);
  });

  VIEWS[ID] = { stats, extra, page, showKinds: () => false, body: genericBody };
})();
