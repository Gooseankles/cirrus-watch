// The key that signs sign-in cookies. SESSION_SECRET when it is set to a real
// value; otherwise a random key made once and kept in DATA_DIR/session-secret,
// so a deployment that forgot it never signs cookies with a key anyone can read
// in this code.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const PLACEHOLDERS = new Set(["change-me", "dev-only-change-me", "changeme", "secret"]);
const FILE = path.join(DATA_DIR, "session-secret");

function sessionSecret() {
  const env = (process.env.SESSION_SECRET || "").trim();
  if (env.length >= 32 && !PLACEHOLDERS.has(env.toLowerCase())) return env;
  if (env) console.warn("SESSION_SECRET is a placeholder or shorter than 32 characters; using a generated key instead.");
  try {
    const kept = fs.readFileSync(FILE, "utf8").trim();
    if (kept.length >= 32) return kept;
  } catch {
    // none yet
  }
  const made = crypto.randomBytes(48).toString("base64url");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, made, { mode: 0o600 });
  } catch (err) {
    console.warn(`Sign-in key kept in memory only (everyone signs in again after a restart): ${err.message}`);
  }
  return made;
}

module.exports = { sessionSecret };
