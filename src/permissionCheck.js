// Which of the permissions the tools need an identity really has, for the
// Settings Test buttons. Graph application permissions come from the "roles"
// claim of its Graph token (only consented ones are in it); Azure roles from
// the role assignments for its object ID on each subscription it can see
// (assignments on a management group above count; ones through a group do not).
const axios = require("axios");
const { NEEDS } = require("./toolPermissions");

const ARM = "https://management.azure.com";
const MAX_SUBSCRIPTIONS = 50;

const ROLE = {
  owner: "8e3af657-a8ff-443c-a75c-2fe8c4bcb635",
  contributor: "b24988ac-6180-42a0-ab88-20f7382dd24c",
  reader: "acdd72a7-3385-48ef-bd42-f606fba81ae7",
  costReader: "72fafb9e-0641-4937-9268-a91bfd8191a3",
  costContributor: "434105ed-43f6-45c7-a02f-909b2ba83430",
  kvReader: "21090545-7ca7-4776-b22c-e363652d74d2",
  kvAdmin: "00482a5a-887f-4fb3-b363-3b7fe8e74483",
};
// A needed role is there when any of these is assigned.
const COVERED_BY = {
  Reader: [ROLE.owner, ROLE.contributor, ROLE.reader],
  "Cost Management Reader": [ROLE.owner, ROLE.contributor, ROLE.reader, ROLE.costReader, ROLE.costContributor],
  "Key Vault Reader": [ROLE.kvReader, ROLE.kvAdmin],
};
// Wider Graph permissions that include a narrower one.
const GRAPH_COVERED_BY = {
  "User.Read.All": ["Directory.Read.All", "Directory.ReadWrite.All", "User.ReadWrite.All"],
  "GroupMember.Read.All": ["Directory.Read.All", "Directory.ReadWrite.All", "Group.Read.All", "Group.ReadWrite.All"],
  "Application.Read.All": ["Directory.Read.All", "Directory.ReadWrite.All", "Application.ReadWrite.All"],
};

const roleName = (s) => String(s).split(" (")[0];

// What the given tools need together (all tools when toolIds is empty).
function required(toolIds) {
  const ids = toolIds && toolIds.length ? toolIds : Object.keys(NEEDS);
  const graph = new Set();
  const azure = new Set();
  for (const id of ids) {
    const n = NEEDS[id] || {};
    (n.graph || []).forEach((p) => graph.add(p));
    (n.azure || []).forEach((r) => azure.add(roleName(r)));
  }
  return { graph: [...graph], azure: [...azure] };
}

function claims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function graphMissing(needed, granted) {
  const has = new Set(granted);
  return needed.filter((p) => !has.has(p) && !has.has(p.replace(".Read.", ".ReadWrite.")) && !(GRAPH_COVERED_BY[p] || []).some((w) => has.has(w)));
}

// The Graph application permissions Entra holds for this identity now. The
// token's roles claim can lag: Azure caches managed identity tokens for up to
// 24 hours, so a permission granted since is in Entra but not yet in the token.
// Needs Application.Read.All; null when it cannot be read.
const GRAPH = "https://graph.microsoft.com/v1.0";
const MS_GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
async function graphAssigned(token, oid) {
  if (!oid) return null;
  try {
    const get = async (url) => {
      const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
      if (r.status >= 300) throw new Error(String(r.status));
      return r.data;
    };
    const msGraph = await get(`${GRAPH}/servicePrincipals(appId='${MS_GRAPH_APP_ID}')?$select=id,appRoles`);
    const names = new Map((msGraph.appRoles || []).map((r) => [r.id, r.value]));
    const out = [];
    let url = `${GRAPH}/servicePrincipals/${oid}/appRoleAssignments?$select=appRoleId,resourceId`;
    while (url) {
      const page = await get(url);
      for (const a of page.value || []) if (a.resourceId === msGraph.id && names.has(a.appRoleId)) out.push(names.get(a.appRoleId));
      url = page["@odata.nextLink"] || null;
    }
    return out;
  } catch {
    return null;
  }
}

async function armGet(url, token) {
  const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
  if (r.status >= 300) throw new Error(`${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

async function checkAzure(cred, needed, configured) {
  if (!needed.length) return { needed, subscriptions: 0, missing: [] };
  const token = (await cred.getToken(`${ARM}/.default`)).token;
  const oid = claims(token).oid;
  const seen = [];
  let url = `${ARM}/subscriptions?api-version=2022-12-01`;
  while (url) {
    const page = await armGet(url, token);
    for (const s of page.value || []) if (s.state === "Enabled") seen.push({ id: s.subscriptionId, name: s.displayName || s.subscriptionId });
    url = page.nextLink;
  }
  const wanted = configured && configured.length ? configured : seen.map((s) => s.id);
  const nameOf = new Map(seen.map((s) => [s.id, s.name]));
  const notVisible = wanted.filter((id) => !nameOf.has(id));
  const subs = wanted.filter((id) => nameOf.has(id)).slice(0, MAX_SUBSCRIPTIONS);
  const missing = new Map(needed.map((r) => [r, []]));
  const failed = [];
  await Promise.all(
    subs.map(async (id) => {
      try {
        const res = await armGet(`${ARM}/subscriptions/${id}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=assignedTo('${oid}')`, token);
        const held = new Set((res.value || []).map((a) => String((a.properties || {}).roleDefinitionId || "").split("/").pop()));
        for (const r of needed) if (!(COVERED_BY[r] || []).some((g) => held.has(g))) missing.get(r).push(nameOf.get(id));
      } catch (err) {
        failed.push(`${nameOf.get(id)} (${err.message.slice(0, 80)})`);
      }
    })
  );
  return {
    needed,
    subscriptions: subs.length,
    more: Math.max(0, wanted.length - notVisible.length - subs.length),
    notVisible,
    missing: [...missing].filter(([, s]) => s.length).map(([role, s]) => ({ role, subscriptions: s.sort() })),
    failed,
  };
}

// toolIds: the tools this identity scans for (empty = all). configured: the
// subscriptions it should scan (empty = every one it sees).
async function check(cred, { toolIds, configured } = {}) {
  const need = required(toolIds);
  const out = {};
  if (need.graph.length) {
    try {
      const token = (await cred.getToken("https://graph.microsoft.com/.default")).token;
      const c = claims(token);
      const granted = c.roles || [];
      let missing = graphMissing(need.graph, granted);
      let pending = [];
      if (missing.length) {
        const inEntra = await graphAssigned(token, c.oid);
        if (inEntra) {
          const still = new Set(graphMissing(missing, inEntra));
          pending = missing.filter((p) => !still.has(p));
          missing = [...still];
        }
      }
      // tokenAge: hours since the token was issued (the cache can keep it up to 24 h).
      const tokenAge = c.iat ? Math.max(0, Math.round((Date.now() / 1000 - c.iat) / 3600)) : null;
      out.graph = { needed: need.graph, granted, missing, pending, tokenAge };
    } catch (err) {
      out.graph = { needed: need.graph, error: String(err.message || err).split("\n")[0].slice(0, 300) };
    }
  }
  try {
    out.azure = await checkAzure(cred, need.azure, configured);
  } catch (err) {
    out.azure = { needed: need.azure, error: String(err.message || err).split("\n")[0].slice(0, 300) };
  }
  return out;
}

module.exports = { check, _test: { required, graphMissing, claims, graphAssigned } };
