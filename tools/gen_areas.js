// node gen_areas.js → areas_new.json：新增平野・盆地・台地的手繪範圍（由土地分類格子描出外形再簡化）
const fs = require("fs");
const MESH = JSON.parse(fs.readFileSync("g05.json", "utf8"));
const set = (...a) => new Set(a);
const LOW = set("19", "20", "21", "22", "23", "24", "25", "26");
const TERR = set("12", "13", "14", "15", "16", "17", "18", "31", "32", "33", "34", "35", "36", "37", "38", "39", "00");
const VFOOT = set("08");
const grid = new Map();
for (const [code, cls] of Object.entries(MESH)) {
  const s = String(code);
  const j = (+s.slice(0, 2)) * 80 + (+s[4]) * 10 + (+s[6]);
  const i = (+s.slice(2, 4)) * 80 + (+s[5]) * 10 + (+s[7]);
  grid.set(i + "," + j, cls === "unknown" ? null : { m: cls.slice(0, 2) });
}
const K = (i, j) => i + "," + j, IJ = (k) => k.split(",").map(Number);
const toWgs = (lon, lat) => [lon - 0.000046038 * lat - 0.000083043 * lon + 0.01004, lat - 0.00010695 * lat + 0.000017464 * lon + 0.0046017];
const toTokyo = (lon, lat) => [lon + 0.000046038 * lat + 0.000083043 * lon - 0.01004, lat + 0.00010695 * lat - 0.000017464 * lon - 0.0046017];
const cellAt = (lon, lat) => { const [x, y] = toTokyo(lon, lat); return [Math.floor((x - 100) * 80), Math.floor(y * 120)]; };
const cellCenter = (i, j) => toWgs(100 + (i + 0.5) / 80, (j + 0.5) / 120);
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const km = (a, b) => Math.hypot((a[0] - b[0]) * 111.32 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110.57);
const OK = { lt: (c) => LOW.has(c.m) || TERR.has(c.m), low: (c) => LOW.has(c.m), pl: (c) => TERR.has(c.m) || VFOOT.has(c.m) };

function cellsOf(c, r, type) {
  const ok = OK[type];
  const [si, sj] = cellAt(...c);
  let seed = null;
  for (let d = 0; d < 8 && !seed; d++)
    for (let di = -d; di <= d && !seed; di++) for (let dj = -d; dj <= d; dj++) {
      const k = K(si + di, sj + dj), g = grid.get(k);
      if (g && ok(g)) { seed = k; break; }
    }
  const out = new Set(seed ? [seed] : []), q = seed ? [seed] : [];
  while (q.length) {
    const [i, j] = IJ(q.pop());
    for (const [di, dj] of N4) {
      const nk = K(i + di, j + dj), g = grid.get(nk);
      if (out.has(nk) || !g || !ok(g) || km(cellCenter(i + di, j + dj), c) > r) continue;
      out.add(nk); q.push(nk);
    }
  }
  return out;
}
function trace(cells) {
  const edges = new Map();
  const add = (a, b) => { const r = b + ">" + a; if (edges.has(r)) edges.delete(r); else edges.set(a + ">" + b, [a, b]); };
  for (const c of cells) {
    const [i, j] = IJ(c), p = (x, y) => x + "," + y;
    add(p(i, j), p(i + 1, j)); add(p(i + 1, j), p(i + 1, j + 1)); add(p(i + 1, j + 1), p(i, j + 1)); add(p(i, j + 1), p(i, j));
  }
  const from = new Map();
  for (const [, [a, b]] of edges) { if (!from.has(a)) from.set(a, []); from.get(a).push(b); }
  const rings = [];
  while (from.size) {
    const start = from.keys().next().value, ring = [start];
    let cur = start;
    for (;;) { const n = from.get(cur), nx = n.pop(); if (!n.length) from.delete(cur); if (nx === start) break; ring.push(nx); cur = nx; }
    rings.push(ring.map(IJ));
  }
  return rings;
}
const area = (r) => r.reduce((a, p, k) => { const q = r[(k + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let md = -1, mi = 0;
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / L;
    if (d > md) { md = d; mi = k; }
  }
  if (md <= tol) return [a, b];
  return [...dp(pts.slice(0, mi + 1), tol).slice(0, -1), ...dp(pts.slice(mi), tol)];
}
function ellipse(c, rx, ry) {
  const kx = 111.32 * Math.cos(c[1] * Math.PI / 180), ky = 110.57;
  return Array.from({ length: 8 }, (_, k) => { const t = (k / 8) * 2 * Math.PI; return [c[0] + (rx * Math.cos(t)) / kx, c[1] + (ry * Math.sin(t)) / ky]; });
}
const r3 = (v) => Math.round(v * 1000) / 1000;
// [名稱, 中心, 半徑 km, 格子種類]；種類 ell = 直接用橢圓（rx, ry）
const SPEC = JSON.parse(fs.readFileSync("areas_spec.json", "utf8"));
const out = {};
for (const [n, c, r, type, ry] of SPEC) {
  let poly;
  if (type === "ell") poly = ellipse(c, r, ry || r);
  else {
    const cells = cellsOf(c, r, type);
    if (cells.size < 6) { poly = ellipse(c, r * 0.6, r * 0.6); console.log("橢圓代替", n, cells.size); }
    else {
      const ring = trace(cells).filter((x) => area(x) > 0).sort((a, b) => area(b) - area(a))[0].map(([i, j]) => toWgs(100 + i / 80, j / 120));
      let tol = 0.012;
      // 閉合環從中間切成兩段各自簡化
      const h = ring.length >> 1, A = ring.slice(0, h + 1), B = [...ring.slice(h), ring[0]];
      const simp = (t) => [...dp(A, t).slice(0, -1), ...dp(B, t).slice(0, -1)];
      poly = simp(tol);
      while (poly.length > 12) poly = simp((tol *= 1.3));
      console.log(n, cells.size, "格", poly.length, "點");
    }
  }
  out[n] = poly.map(([x, y]) => [r3(x), r3(y)]);
}
fs.writeFileSync("areas_new.json", JSON.stringify(out));
