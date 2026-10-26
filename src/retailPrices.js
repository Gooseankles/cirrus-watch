// Azure list prices from the public Retail Prices API (no sign-in, no Azure
// permission). Used for "what this costs a month" estimates: list prices, so
// discounts, reservations and agreement prices are not in them.
// One query per distinct filter, cached for a day per currency.
const settings = require("./settings");

const API = "https://prices.azure.com/api/retail/prices";
const TTL_MS = 24 * 3600 * 1000;
const MAX_PAGES = 5;
const HOURS_PER_MONTH = 730;
const cache = new Map(); // `${currency}|${filter}` -> { at, items } or { at, promise }

function currency() {
  const c = String(settings.get("PRICE_CURRENCY") || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : "NOK";
}

// OData string literal: a quote is doubled.
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function fetchItems(filter, cur) {
  let url = `${API}?currencyCode=${encodeURIComponent(cur)}&$filter=${encodeURIComponent(filter)}`;
  const items = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Retail Prices API (${res.status})`);
    const data = await res.json();
    items.push(...(data.Items || []));
    url = data.NextPageLink || null;
  }
  return items;
}

// Every price item matching an OData filter (consumption prices only).
async function query(filter) {
  const cur = currency();
  const full = `${filter} and type eq 'Consumption'`;
  const key = `${cur}|${full}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items || hit.promise;
  const promise = fetchItems(full, cur).then(
    (items) => {
      cache.set(key, { at: Date.now(), items });
      return items;
    },
    (err) => {
      cache.delete(key);
      throw err;
    }
  );
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

// A price per month from an item: hourly meters are counted at 730 hours.
function monthly(item) {
  if (!item) return null;
  const unit = String(item.unitOfMeasure || "");
  if (/^1[ /]Hour$/i.test(unit)) return item.retailPrice * HOURS_PER_MONTH;
  if (/^1\/Month$/i.test(unit) || /^1 GB\/Month$/i.test(unit)) return item.retailPrice;
  return null;
}

module.exports = { query, lit, monthly, currency, HOURS_PER_MONTH, _cache: cache };
