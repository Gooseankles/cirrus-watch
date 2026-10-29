// The fingerprint of a diagram: its source text plus what else decides the picture,
// line ends made LF. A Mermaid source (.mmd) is hashed with the shared mermaid.json;
// a Python source (.py, the "diagrams" library with the Azure icons) with the
// Dockerfile and _style.py it draws with. scripts/diagrams.mjs stores it in
// docs/diagrams/rendered.json after a render; docs:check compares it to tell a PNG
// that was not rendered again.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Source kind (the file ending) -> the shared files in docs/diagrams that are part of the fingerprint.
export const KINDS = { mmd: ["mermaid.json"], py: ["Dockerfile", "_style.py"] };

export function diagramHash(source, ...shared) {
  const lf = (s) => s.replace(/\r\n/g, "\n");
  const h = createHash("sha256").update(lf(source));
  for (const s of shared) h.update("\0").update(lf(s));
  return h.digest("hex").slice(0, 16);
}

// The pictures in a diagram folder, sorted by name: { name, kind, file }. A file whose name
// starts with "_" is a helper the sources import, not a picture. One name has one source.
export function listDiagrams(dir) {
  const found = new Map();
  for (const f of readdirSync(dir).sort()) {
    const kind = Object.keys(KINDS).find((k) => f.endsWith(`.${k}`));
    if (!kind || f.startsWith("_")) continue;
    const name = f.slice(0, -(kind.length + 1));
    if (found.has(name)) throw new Error(`docs/diagrams/${name} has both a .mmd and a .py source; keep one`);
    found.set(name, { name, kind, file: f });
  }
  return [...found.values()];
}

// The fingerprint of one listed picture; text is its source when the caller already has it.
export function sourceHash(dir, diagram, text = readFileSync(join(dir, diagram.file), "utf8")) {
  return diagramHash(text, ...KINDS[diagram.kind].map((f) => readFileSync(join(dir, f), "utf8")));
}
