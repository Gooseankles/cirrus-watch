// Writes a JSON file through a temporary file and a rename, so a crash or a
// full disk mid-write leaves the old file instead of a cut-off one.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

module.exports = { writeAtomic };
