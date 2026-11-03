// Resource Graph and Log Analytics queries written in the scans: shapes KQL
// refuses with a ParserFailure, caught here instead of in a tenant. Reads the
// source only, no Azure.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".js") ? [p] : [];
  });
}

test("no query names a column inside distinct (distinct x = f(y) is a parser failure)", () => {
  const bad = [];
  for (const file of sources(path.join(__dirname, "..", "src"))) {
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/\|\s*distinct\s+[A-Za-z_]\w*\s*=[^=~]/.test(line)) bad.push(`${path.relative(path.join(__dirname, ".."), file)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
