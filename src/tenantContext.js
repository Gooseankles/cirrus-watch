// Which customer tenant the current piece of work is for. A scan runs once per
// tenant inside runIn(); credentials, the subscription list and the activity
// log read the tenant from here, so the tools themselves need no changes.
const { AsyncLocalStorage } = require("async_hooks");

const HOME = "home";
const als = new AsyncLocalStorage();

function runIn(tenant, fn) {
  return als.run(tenant, fn);
}

// The tenant object, or null outside a run (= the home tenant).
function current() {
  return als.getStore() || null;
}

function isHome(tenant) {
  return !tenant || tenant.key === HOME;
}

module.exports = { HOME, runIn, current, isHome };
