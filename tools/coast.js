// node coast.js <japan.topojson> <spec.json>  → 依起訖點從官方海岸線（地球地図日本）擷取沿岸線段
// spec：{名稱: [[起點經,緯], [終點經,緯]]}；輸出 {名稱: [[經,緯],...]}（簡化到約 0.6 km）
const fs = require("fs");
const { mesh } = require("topojson-client");
const [topoPath, specPath] = process.argv.slice(2);
const T = JSON.parse(fs.readFileSync(topoPath, "utf8"));
const lines = mesh(T, T.objects.japan, (a, b) => a === b).coordinates; // 海岸線（已接成長線）
const SPEC = JSON.parse(fs.readFileSync(specPath, "utf8"));
const d2 = (a, b) => (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * 1.2) ** 2;
function nearest(p) {
  let best = { d: Infinity };
  lines.forEach((ln, li) => ln.forEach((q, qi) => { const d = d2(p, q); if (d < best.d) best = { d, li, qi }; }));
  return best;
}
const len = (pts) => pts.reduce((a, p, i) => (i ? a + Math.sqrt(d2(p, pts[i - 1])) : 0), 0);
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let md = -1, mi = 0;
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / L;
    if (d > md) { md = d; mi = k; }
  }
  return md <= tol ? [a, b] : [...dp(pts.slice(0, mi + 1), tol).slice(0, -1), ...dp(pts.slice(mi), tol)];
}
const out = {};
for (const [n, [A, B]] of Object.entries(SPEC)) {
  const a = nearest(A), b = nearest(B);
  if (a.li !== b.li) { console.log("起訖點不在同一條海岸線：", n); continue; }
  const ln = lines[a.li], [i, j] = [Math.min(a.qi, b.qi), Math.max(a.qi, b.qi)];
  // 封閉的島嶼海岸線有兩個方向，取較短的一段
  const direct = ln.slice(i, j + 1);
  const closed = d2(ln[0], ln[ln.length - 1]) < 1e-12;
  const wrap = closed ? [...ln.slice(j), ...ln.slice(1, i + 1)] : null;
  let seg = wrap && len(wrap) < len(direct) ? wrap : direct;
  if (d2(seg[0], A) > d2(seg[seg.length - 1], A)) seg = seg.slice().reverse();
  out[n] = dp(seg, 0.005).map((p) => p.map((v) => Math.round(v * 1000) / 1000));
  console.log(n, seg.length, "→", out[n].length, "點");
}
process.stdout.write(JSON.stringify(out) + "\n");
