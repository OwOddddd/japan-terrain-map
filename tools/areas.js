// node areas.js g05.json terrain.js out.json
// 以國土數值情報「土地分類メッシュ」(1km) 的地形分類，從手繪範圍中心向外連通取出低地＋台地格子，描出平野／盆地外框
const fs = require("fs");
const [g05Path, terrainPath, outPath] = process.argv.slice(2);
const MESH = JSON.parse(fs.readFileSync(g05Path, "utf8"));
const CATS = new Function(fs.readFileSync(terrainPath, "utf8") + ";return CATS")();

// 地形分類主分類：低地 19–23, 26（含其中的湖沼 24、河川 25）；台地・段丘 13–18, 31–39, 00
const LOW = new Set(["19", "20", "21", "22", "23", "24", "25", "26"]);
const TERR = new Set(["13", "14", "15", "16", "17", "18", "31", "32", "33", "34", "35", "36", "37", "38", "39", "00"]);
const TARGETS = {
  "関東平野": { keep: (c) => LOW.has(c) || TERR.has(c), margin: 0.12 },
  "濃尾平野": { keep: (c) => LOW.has(c) || TERR.has(c), margin: 0.06 },
  "奈良盆地": { keep: (c) => LOW.has(c) || TERR.has(c), margin: 0.04 },
};

// 3次メッシュ（約1km）：格子索引 i = 經度/(1/80)，j = 緯度/(1/120)，資料為舊日本測地系
const cellOf = (code) => {
  const s = String(code);
  const j = (+s.slice(0, 2)) * 80 + (+s[4]) * 10 + (+s[6]);
  const i = (+s.slice(2, 4)) * 80 + (+s[5]) * 10 + (+s[7]);
  return [i, j];
};
const grid = new Map();
for (const [code, cls] of Object.entries(MESH)) {
  const [i, j] = cellOf(code);
  grid.set(i + "," + j, cls.slice(0, 2));
}
const toLonLat = (i, j) => {
  // 舊日本測地系 → 世界測地系（近似式，誤差數十公尺）
  const lat = j / 120, lon = 100 + i / 80;
  return [lon - 0.000046038 * lat - 0.000083043 * lon + 0.01004, lat - 0.00010695 * lat + 0.000017464 * lon + 0.0046017];
};
const cellAt = (lon, lat) => [Math.floor((lon - 100) * 80), Math.floor(lat * 120)];

function trace(cells) {
  // 每格四條有向邊，相鄰格共用的邊抵銷，剩下的串成外框環
  const edges = new Map();
  const add = (a, b) => {
    const k = a + ">" + b, r = b + ">" + a;
    if (edges.has(r)) edges.delete(r); else edges.set(k, [a, b]);
  };
  for (const c of cells) {
    const [i, j] = c.split(",").map(Number);
    const p = (x, y) => x + "," + y;
    add(p(i, j), p(i + 1, j)); add(p(i + 1, j), p(i + 1, j + 1)); add(p(i + 1, j + 1), p(i, j + 1)); add(p(i, j + 1), p(i, j));
  }
  const from = new Map();
  for (const [, [a, b]] of edges) { if (!from.has(a)) from.set(a, []); from.get(a).push(b); }
  const rings = [];
  while (from.size) {
    const start = from.keys().next().value;
    const ring = [start];
    let cur = start;
    for (;;) {
      const nexts = from.get(cur);
      const nx = nexts.pop();
      if (!nexts.length) from.delete(cur);
      if (nx === start) break;
      ring.push(nx); cur = nx;
    }
    rings.push(ring.map((s) => s.split(",").map(Number)));
  }
  return rings;
}
const ringArea = (r) => r.reduce((a, p, k) => { const q = r[(k + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const chaikin = (r, n) => {
  for (let t = 0; t < n; t++) {
    const o = [];
    for (let k = 0; k < r.length; k++) {
      const a = r[k], b = r[(k + 1) % r.length];
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    r = o;
  }
  return r;
};

// 道格拉斯-普克簡化（閉合環從最遠點切開）
const dp = (pts, tol) => {
  if (pts.length < 3) return pts;
  const [x1, y1] = pts[0], [x2, y2] = pts[pts.length - 1], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1e-12;
  let best = 0, idx = 0;
  for (let k = 1; k < pts.length - 1; k++) { const d = Math.abs(dy * pts[k][0] - dx * pts[k][1] + x2 * y1 - y2 * x1) / L; if (d > best) { best = d; idx = k; } }
  return best > tol ? [...dp(pts.slice(0, idx + 1), tol).slice(0, -1), ...dp(pts.slice(idx), tol)] : [pts[0], pts[pts.length - 1]];
};
const dpRing = (r, tol) => {
  let far = 0, fd = 0;
  r.forEach((p, k) => { const d = (p[0] - r[0][0]) ** 2 + (p[1] - r[0][1]) ** 2; if (d > fd) { fd = d; far = k; } });
  return [...dp(r.slice(0, far + 1), tol).slice(0, -1), ...dp([...r.slice(far), r[0]], tol).slice(0, -1)];
};
const out = {};
for (const cat of CATS) for (const it of cat.items) {
  const T = TARGETS[it.n];
  if (!T || !it.p) continue;
  const lons = it.p.map((p) => p[0]), lats = it.p.map((p) => p[1]);
  const [i0, j0] = cellAt(Math.min(...lons) - T.margin, Math.min(...lats) - T.margin);
  const [i1, j1] = cellAt(Math.max(...lons) + T.margin, Math.max(...lats) + T.margin);
  const seed = cellAt(...(it.l || [lons.reduce((a, b) => a + b) / lons.length, lats.reduce((a, b) => a + b) / lats.length]));
  // 從種子附近最近的符合格開始連通
  let start = null;
  for (let rr = 0; rr < 30 && !start; rr++)
    for (let di = -rr; di <= rr && !start; di++) for (let dj = -rr; dj <= rr && !start; dj++) {
      const k = seed[0] + di + "," + (seed[1] + dj);
      if (grid.has(k) && T.keep(grid.get(k))) start = k;
    }
  const seen = new Set([start]), q = [start];
  let unknown = 0;
  while (q.length) {
    const [i, j] = q.pop().split(",").map(Number);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj, k = ni + "," + nj;
      if (ni < i0 || ni > i1 || nj < j0 || nj > j1 || seen.has(k)) continue;
      const c = grid.get(k);
      if (c === "un") unknown++;
      if (c && T.keep(c)) { seen.add(k); q.push(k); }
    }
  }
  // 外環保留、面積小於 6 格的內洞填平
  const rings = trace(seen).filter((r) => ringArea(r) > 0 || -ringArea(r) >= 6);
  const outer = rings.filter((r) => ringArea(r) > 0).sort((a, b) => ringArea(b) - ringArea(a));
  const holes = rings.filter((r) => ringArea(r) < 0);
  const toGeo = (r) => { const s = dpRing(chaikin(r, 2), 0.35).map(([x, y]) => toLonLat(x, y).map((v) => Math.round(v * 1e4) / 1e4)); s.push(s[0]); return s; };
  // d3 需要外環順時針：格子座標（y 向北）逆時針 → 反轉
  out[it.n] = { type: "Polygon", coordinates: [toGeo(outer[0]).reverse(), ...holes.map((h) => toGeo(h).reverse())] };
  console.log(it.n, "格數", seen.size, "內洞", holes.length, "未分類格", unknown);
}
fs.writeFileSync(outPath, JSON.stringify(out));
