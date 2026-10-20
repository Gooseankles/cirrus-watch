// Keeps sign-in sessions as files under DATA_DIR/sessions, so an App Service
// restart (every app-setting change causes one) does not sign everyone out.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const { DATA_DIR } = require("./paths");

const DIR = path.join(DATA_DIR, "sessions");
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 60 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

function fileFor(sid) {
  return path.join(DIR, `${crypto.createHash("sha256").update(sid).digest("hex")}.json`);
}

function expiryOf(sess) {
  const cookieExpiry = sess && sess.cookie && sess.cookie.expires && Date.parse(sess.cookie.expires);
  return cookieExpiry || Date.now() + DEFAULT_TTL_MS;
}

class FileSessionStore extends session.Store {
  constructor() {
    super();
    this.lastTouch = new Map();
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    setInterval(() => this.sweep(), SWEEP_MS).unref();
  }

  get(sid, cb) {
    fs.readFile(fileFor(sid), "utf8", (err, text) => {
      if (err) return cb(err.code === "ENOENT" ? null : err, null);
      try {
        const record = JSON.parse(text);
        if (record.expires < Date.now()) return this.destroy(sid, () => cb(null, null));
        cb(null, record.sess);
      } catch {
        cb(null, null);
      }
    });
  }

  set(sid, sess, cb) {
    const file = fileFor(sid);
    const tmp = `${file}.${process.pid}.tmp`;
    const text = JSON.stringify({ expires: expiryOf(sess), sess });
    fs.writeFile(tmp, text, { mode: 0o600 }, (err) => {
      if (err) return cb && cb(err);
      fs.rename(tmp, file, (renameErr) => cb && cb(renameErr || null));
    });
  }

  // The page polls every few seconds; rewriting the file each time would be
  // wasted I/O on App Service's network-backed /home.
  touch(sid, sess, cb) {
    const now = Date.now();
    if (now - (this.lastTouch.get(sid) || 0) < TOUCH_EVERY_MS) return cb && cb(null);
    this.lastTouch.set(sid, now);
    this.set(sid, sess, cb);
  }

  destroy(sid, cb) {
    this.lastTouch.delete(sid);
    fs.unlink(fileFor(sid), (err) => cb && cb(err && err.code !== "ENOENT" ? err : null));
  }

  sweep() {
    fs.readdir(DIR, (err, names) => {
      if (err) return;
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        const file = path.join(DIR, name);
        fs.readFile(file, "utf8", (readErr, text) => {
          if (readErr) return;
          try {
            if (JSON.parse(text).expires < Date.now()) fs.unlink(file, () => {});
          } catch {
            fs.unlink(file, () => {});
          }
        });
      }
    });
  }
}

module.exports = { FileSessionStore };
