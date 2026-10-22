// IPv4 ranges for the IPAM scan: parsing CIDR prefixes, overlaps and the
// free space left in a range. Addresses are plain numbers (0 .. 2^32-1);
// IPv6 prefixes are not handled (parse returns null for them).

const MAX = 2 ** 32;

// "10.1.0.0/16" -> { cidr, start, end, bits, size }. A prefix with host bits
// set ("10.1.2.3/16") is taken as its network, the way Azure stores it.
function parse(text) {
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?\s*$/.exec(String(text || ""));
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const bits = m[5] === undefined ? 32 : Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return null;
  const ip = ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
  const size = 2 ** (32 - bits);
  const start = Math.floor(ip / size) * size;
  return { cidr: `${toIp(start)}/${bits}`, start, end: start + size - 1, bits, size };
}

function toIp(n) {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
}

const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;
const contains = (outer, inner) => outer.start <= inner.start && inner.end <= outer.end;

// RFC 1918 plus the shared 100.64.0.0/10 range, which Azure also allows.
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"].map(parse);
const isPrivate = (r) => PRIVATE.some((p) => contains(p, r));

// Ranges merged into sorted, non-overlapping [start, end] spans.
function merge(ranges) {
  const sorted = ranges.map((r) => [r.start, r.end]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// The largest aligned CIDR blocks covering [start, end], in order.
function spanToBlocks(start, end) {
  const out = [];
  while (start <= end) {
    let size = start === 0 ? MAX : 2 ** Math.min(32, countTrailingZeros(start));
    while (start + size - 1 > end) size /= 2;
    out.push(parse(`${toIp(start)}/${32 - Math.log2(size)}`));
    start += size;
  }
  return out;
}
function countTrailingZeros(n) {
  let z = 0;
  while (z < 32 && n % 2 === 0) {
    n /= 2;
    z++;
  }
  return z;
}

// The parts of `pool` no range in `used` touches, as CIDR blocks.
function freeBlocks(pool, used) {
  const taken = merge(used.filter((u) => overlaps(u, pool)).map((u) => ({ start: Math.max(u.start, pool.start), end: Math.min(u.end, pool.end) })));
  const out = [];
  let at = pool.start;
  for (const [s, e] of taken) {
    if (s > at) out.push(...spanToBlocks(at, s - 1));
    at = Math.max(at, e + 1);
  }
  if (at <= pool.end) out.push(...spanToBlocks(at, pool.end));
  return out;
}

// Free /bits blocks in the pool, lowest first (at most `limit`), and how many
// there are in all.
function freeOfSize(pool, used, bits, limit = 50) {
  const list = [];
  let count = 0;
  for (const b of freeBlocks(pool, used)) {
    if (b.bits > bits) continue;
    const n = 2 ** (bits - b.bits);
    count += n;
    const step = 2 ** (32 - bits);
    for (let i = 0; i < n && list.length < limit; i++) list.push(parse(`${toIp(b.start + i * step)}/${bits}`).cidr);
  }
  return { list, count };
}

// Addresses in the pool that no used range covers.
function freeAddresses(pool, used) {
  return freeBlocks(pool, used).reduce((n, b) => n + b.size, 0);
}

module.exports = { parse, toIp, overlaps, contains, isPrivate, merge, freeBlocks, freeOfSize, freeAddresses };
