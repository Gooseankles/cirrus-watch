// The fingerprint of a diagram: its Mermaid text plus the shared config, line ends
// made LF. scripts/diagrams.mjs stores it in docs/diagrams/rendered.json after a
// render; docs:check compares it to tell a PNG that was not rendered again.
import { createHash } from "node:crypto";

export function diagramHash(mmd, config) {
  const lf = (s) => s.replace(/\r\n/g, "\n");
  return createHash("sha256").update(lf(mmd)).update("\0").update(lf(config)).digest("hex").slice(0, 16);
}
