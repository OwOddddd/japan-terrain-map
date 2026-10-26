// node precise.js g05.json terrain.js out.topojson
// 「精緻版」範圍：以國土數值情報「土地分類メッシュ」(1km) 的地形分類，把每一格只分給一個地形，邊界彼此嵌合
//  1. 平野＋盆地：低地・台地格子，從各自中心同時向外擴張（先到先得），範圍限制在手繪範圍附近
//  2. 台地・高原：台地・火山麓地格子（喀斯特台地用カルスト格子），可落在平野之內（套疊）
//  3. 山脈・山地：剩下的山地・丘陵格子，分給距離最近的山脈脊線
//  4. 轉成 TopoJSON 讓相鄰範圍共用同一條邊界，再一起簡化、平滑
const fs = require("fs");
const { topology } = require("topojson-server");
const { presimplify, simplify } = require("topojson-simplify");
const { quantize } = require("topojson-client");
const [g05Path, terrainPath, outPath] = process.argv.slice(2);
const MESH = JSON.parse(fs.readFileSync(g05Path, "utf8"));
const CATS = new Function(fs.readFileSync(terrainPath, "utf8") + ";return CATS")();

const set = (...a) => new Set(a);
const LOW = set("19", "20", "21", "22", "23", "24", "25", "26");
const TERR = set("12", "13", "14", "15", "16", "17", "18", "31", "32", "33", "34", "35", "36", "37", "38", "39", "00");
const MTN = set("01", "02", "03", "04", "05", "06", "07");
const HILL = set("09", "10", "11");
const VFOOT = set("08");
const KARST = set("秋吉台", "平尾台", "四国カルスト");

// ---------- 格子 ----------
const grid = new Map(); // "i,j" → {m: 主分類, s: 副分類}
for (const [code, cls] of Object.entries(MESH)) {
  const s = String(code);
  const j = (+s.slice(0, 2)) * 80 + (+s[4]) * 10 + (+s[6]);
  const i = (+s.slice(2, 4)) * 80 + (+s[5]) * 10 + (+s[7]);
  grid.set(i + "," + j, cls === "unknown" ? null : { m: cls.slice(0, 2), s: cls.slice(2) });
}
const K = (i, j) => i + "," + j;
const IJ = (k) => k.split(",").map(Number);
// 舊日本測地系 ⇄ 世界測地系（近似）
const toWgs = (lon, lat) => [lon - 0.000046038 * lat - 0.000083043 * lon + 0.01004, lat - 0.00010695 * lat + 0.000017464 * lon + 0.0046017];
const toTokyo = (lon, lat) => [lon + 0.000046038 * lat + 0.000083043 * lon - 0.01004, lat + 0.00010695 * lat - 0.000017464 * lon - 0.0046017];
const cellAt = (lon, lat) => { const [x, y] = toTokyo(lon, lat); return [Math.floor((x - 100) * 80), Math.floor(y * 120)]; };
const cellCenter = (i, j) => toWgs(100 + (i + 0.5) / 80, (j + 0.5) / 120);
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function findSeed([lon, lat], ok) {
  const [si, sj] = cellAt(lon, lat);
  for (let r = 0; r < 25; r++)
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const k = K(si + di, sj + dj), c = grid.get(k);
      if (c && ok(c)) return k;
    }
  return null;
}
function boxOf(pts, margin) {
  const [a, b] = cellAt(Math.min(...pts.map((p) => p[0])) - margin, Math.min(...pts.map((p) => p[1])) - margin);
  const [c, d] = cellAt(Math.max(...pts.map((p) => p[0])) + margin, Math.max(...pts.map((p) => p[1])) + margin);
  return { i0: a, j0: b, i1: c, j1: d };
}
const inBox = (b, i, j) => i >= b.i0 && i <= b.i1 && j >= b.j0 && j <= b.j1;
const center = (it) => it.l || it.c || [it.p.reduce((a, p) => a + p[0], 0) / it.p.length, it.p.reduce((a, p) => a + p[1], 0) / it.p.length];

const items = (id) => CATS.find((c) => c.id === id).items;
const regions = []; // {n, cells:Set, layer}
const log = [];

// ---------- 1. 平野＋盆地：同時擴張 ----------
const owner = new Map();
const lowRegs = [];
for (const [id, margin] of [["plain", 0.15], ["basin", 0.07]])
  for (const it of items(id)) {
    const isLT = (c) => LOW.has(c.m) || TERR.has(c.m);
    const seed = findSeed(center(it), isLT);
    if (!seed || owner.has(seed)) { log.push(`沿用手繪：${it.n}（附近找不到低地・台地格子）`); continue; }
    const r = { n: it.n, cells: new Set([seed]), box: boxOf(it.p, margin), layer: "excl" };
    owner.set(seed, r);
    lowRegs.push(r);
  }
let frontier = lowRegs.map((r) => [...r.cells][0]);
while (frontier.length) {
  const next = [];
  for (const k of frontier) {
    const r = owner.get(k), [i, j] = IJ(k);
    for (const [di, dj] of N4) {
      const ni = i + di, nj = j + dj, nk = K(ni, nj);
      if (owner.has(nk) || !inBox(r.box, ni, nj)) continue;
      const c = grid.get(nk);
      if (!c || !(LOW.has(c.m) || TERR.has(c.m))) continue;
      owner.set(nk, r); r.cells.add(nk); next.push(nk);
    }
  }
  frontier = next;
}
// 填平被同一範圍包住的小洞（≤ 12 格，且沒有被其他地形占用）
function fillHoles(r, maxSize, canTake) {
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (const k of r.cells) { const [i, j] = IJ(k); i0 = Math.min(i0, i); j0 = Math.min(j0, j); i1 = Math.max(i1, i); j1 = Math.max(j1, j); }
  i0--; j0--; i1++; j1++;
  const outside = new Set(), st = [];
  for (let i = i0; i <= i1; i++) for (const j of [j0, j1]) st.push(K(i, j));
  for (let j = j0; j <= j1; j++) for (const i of [i0, i1]) st.push(K(i, j));
  while (st.length) {
    const k = st.pop();
    if (outside.has(k) || r.cells.has(k)) continue;
    const [i, j] = IJ(k);
    if (i < i0 || i > i1 || j < j0 || j > j1) continue;
    outside.add(k);
    for (const [di, dj] of N4) st.push(K(i + di, j + dj));
  }
  const seen = new Set();
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const k = K(i, j);
    if (r.cells.has(k) || outside.has(k) || seen.has(k)) continue;
    const comp = [], q = [k]; seen.add(k);
    while (q.length) {
      const c = q.pop(); comp.push(c);
      const [a, b] = IJ(c);
      for (const [di, dj] of N4) { const n = K(a + di, b + dj); if (!r.cells.has(n) && !outside.has(n) && !seen.has(n)) { seen.add(n); q.push(n); } }
    }
    if (comp.length <= maxSize && comp.every(canTake)) comp.forEach((c) => { r.cells.add(c); owner.set(c, r); });
  }
}
for (const r of lowRegs) fillHoles(r, 12, (c) => !owner.has(c));

// 範圍過小補強：小盆地、高原的 1 km 格子常被周圍的山地吃掉（例：三次盆地、蒜山高原）。
// 結果不到「手繪範圍內陸地格子數」的 40% 時，補上手繪範圍內、尚未被其他地形占用的格子，並標記為概略範圍
const ringHas = (r, x, y) => { let c = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) { const [xi, yi] = r[a], [xj, yj] = r[b]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
function handCells(it) {
  const b = boxOf(it.p, 0), out = [];
  for (let i = b.i0; i <= b.i1; i++) for (let j = b.j0; j <= b.j1; j++) {
    const k = K(i, j);
    if (!grid.has(k)) continue; // 只算陸地格子
    const [x, y] = cellCenter(i, j);
    if (ringHas(it.p, x, y)) out.push(k);
  }
  return out;
}
const byName = new Map(CATS.flatMap((c) => c.items).map((it) => [it.n, it]));
for (const r of lowRegs) {
  const hc = handCells(byName.get(r.n));
  if (r.cells.size >= 0.4 * hc.length) continue;
  const before = r.cells.size;
  for (const k of hc) if (!owner.has(k)) { owner.set(k, r); r.cells.add(k); }
  r.supp = true;
  log.push(`補強：${r.n} ${before} → ${r.cells.size} 格（手繪範圍 ${hc.length} 格）`);
}
regions.push(...lowRegs);

// ---------- 2. 台地・高原（可套疊在平野內） ----------
const plateauCells = new Set();
for (const it of items("plateau")) {
  const karst = KARST.has(it.n);
  const ok = karst ? (c) => c.s === "1" : (c) => TERR.has(c.m) || VFOOT.has(c.m);
  const box = boxOf(it.p, karst ? 0.03 : 0.05);
  let cells;
  if (it.n === "シラス台地") {
    // 被河谷切成許多碎塊：收集範圍內全部「シラス台地」格子，留下 4 格以上的塊
    const all = new Set();
    for (const [k, c] of grid) { const [i, j] = IJ(k); if (c && c.m === "15" && inBox(box, i, j)) all.add(k); }
    cells = new Set();
    const seen = new Set();
    for (const k of all) {
      if (seen.has(k)) continue;
      const comp = [], cq = [k]; seen.add(k);
      while (cq.length) { const c = cq.pop(); comp.push(c); const [a, b] = IJ(c); for (const [di, dj] of N4) { const n = K(a + di, b + dj); if (all.has(n) && !seen.has(n)) { seen.add(n); cq.push(n); } } }
      if (comp.length >= 4) comp.forEach((c) => cells.add(c));
    }
  }
  const seed = cells ? [...cells][0] : findSeed(center(it), ok);
  if (!cells) cells = new Set(seed ? [seed] : []);
  const q = it.n === "シラス台地" || !seed ? [] : [seed];
  while (q.length) {
    const [i, j] = IJ(q.pop());
    for (const [di, dj] of N4) {
      const ni = i + di, nj = j + dj, nk = K(ni, nj), c = grid.get(nk);
      if (cells.has(nk) || !inBox(box, ni, nj) || !c || !ok(c)) continue;
      cells.add(nk); q.push(nk);
    }
  }
  // 範圍過小（含找不到格子）：補上手繪範圍內的陸地格子（台地可套疊在平野上）
  const hc = handCells(it);
  let supp = false;
  // シラス台地的手繪範圍刻意畫得很大（含非台地的陸地），以官方「シラス台地」格子為準，不補強
  if (it.n !== "シラス台地" && cells.size < 0.4 * hc.length) {
    const before = cells.size;
    hc.forEach((k) => cells.add(k)); supp = true;
    log.push(`補強：${it.n} ${before} → ${cells.size} 格（手繪範圍 ${hc.length} 格）`);
  }
  if (cells.size < 3) { log.push(`沿用手繪：${it.n}（只有 ${cells.size} 格）`); continue; }
  const r = { n: it.n, cells, layer: "plateau", supp };
  fillHoles(r, 6, () => true);
  r.cells.forEach((c) => plateauCells.add(c));
  regions.push(r);
}

// ---------- 3. 山脈・山地：剩下的山地・丘陵格子分給最近的脊線 ----------
const kmPerDeg = (lat) => [111.32 * Math.cos(lat * Math.PI / 180), 110.57];
// 回傳 {d: 到脊線的距離 km, end: 最近點是否落在脊線頭尾端點之外}
function distToSpine(p, s) {
  const [kx, ky] = kmPerDeg(p[1]);
  let best = { d: Infinity, end: false };
  for (let a = 0; a < s.length - 1; a++) {
    const ax = (s[a][0] - p[0]) * kx, ay = (s[a][1] - p[1]) * ky, bx = (s[a + 1][0] - p[0]) * kx, by = (s[a + 1][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9;
    const raw = -(ax * dx + ay * dy) / L, t = Math.max(0, Math.min(1, raw));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    const end = (a === 0 && raw < 0) || (a === s.length - 2 && raw > 1);
    if (d < best.d) best = { d, end };
  }
  return best;
}
// 側面容許 hw + max(10, hw)；頭尾端點外只容許 hw/2 + 3 km，避免山脈越過端點吃進相鄰山地（例：生駒→金剛、奥羽→下北）
const ranges = items("range").map((it) => {
  const hw = it.w / 2, lim = hw + Math.max(10, hw), limEnd = hw / 2 + 3;
  return { it, hw, lim, limEnd, box: boxOf(it.s, lim / 90 + 0.05), core: new Set(), r: { n: it.n, cells: new Set(), layer: "excl" } };
});
for (const [k, c] of grid) {
  if (!c || !(MTN.has(c.m) || HILL.has(c.m)) || owner.has(k) || plateauCells.has(k)) continue;
  const [i, j] = IJ(k);
  let best = null;
  for (const R of ranges) {
    if (!inBox(R.box, i, j)) continue;
    const { d, end } = distToSpine(cellCenter(i, j), R.it.s);
    if (d <= (end ? R.limEnd : R.lim) && (!best || d < best.d)) best = { d, R };
  }
  if (best) { best.R.r.cells.add(k); if (best.d <= best.R.hw) best.R.core.add(k); }
}
for (const R of ranges) {
  // 只留下大於 15 格的連通塊
  const keep = new Set(), seen = new Set();
  for (const k of R.r.cells) {
    if (seen.has(k)) continue;
    const comp = [], q = [k]; seen.add(k);
    while (q.length) {
      const c = q.pop(); comp.push(c);
      const [a, b] = IJ(c);
      for (const [di, dj] of N4) { const n = K(a + di, b + dj); if (R.r.cells.has(n) && !seen.has(n)) { seen.add(n); q.push(n); } }
    }
    // 只留下 15 格以上、且有格子落在脊線帶寬內的連通塊（隔海或離太遠的零碎山地不算）
    if (comp.length >= 15 && comp.some((c) => R.core.has(c))) comp.forEach((c) => keep.add(c));
  }
  R.r.cells = keep;
  if (!keep.size) { log.push(`沿用手繪：${R.it.n}（找不到山地格子）`); continue; }
  regions.push(R.r);
}

// ---------- 4. 格子 → 多邊形 → TopoJSON（共用邊界）→ 簡化、平滑 ----------
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
    for (;;) {
      const nexts = from.get(cur), nx = nexts.pop();
      if (!nexts.length) from.delete(cur);
      if (nx === start) break;
      ring.push(nx); cur = nx;
    }
    rings.push(ring.map(IJ));
  }
  return rings;
}
const area = (r) => r.reduce((a, p, k) => { const q = r[(k + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const inside = (pt, ring) => {
  let c = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xi, yi] = ring[a], [xj, yj] = ring[b];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const geo = (r) => { const g = r.map(([i, j]) => toWgs(100 + i / 80, j / 120)); g.push(g[0]); return g; };
const features = regions.map((r) => {
  const rings = trace(r.cells);
  const outers = rings.filter((x) => area(x) > 0).map((o) => [o]);
  for (const h of rings.filter((x) => area(x) < 0)) {
    const host = outers.find((o) => inside([h[0][0] + 0.5, h[0][1] + 0.5], o[0])) || outers.find((o) => inside(h[0], o[0]));
    if (host) host.push(h);
  }
  return { type: "Feature", properties: { n: r.n, layer: r.layer, s: r.supp ? 1 : 0 }, geometry: { type: "MultiPolygon", coordinates: outers.map((p) => p.map(geo)) } };
});
let topo = topology({ precise: { type: "FeatureCollection", features } });
topo = simplify(presimplify(topo), 2.5e-4);
// 每條共用邊各自平滑一次（端點固定），相鄰範圍仍沿用同一條線
const chaikin = (arc) => {
  if (arc.length < 3) return arc;
  let a = arc;
  for (let t = 0; t < 1; t++) {
    const o = [a[0]];
    for (let k = 0; k < a.length - 1; k++) {
      const p = a[k], q = a[k + 1];
      if (k > 0) o.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      if (k < a.length - 2) o.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    o.push(a[a.length - 1]);
    a = o;
  }
  return a;
};
topo.arcs = topo.arcs.map((arc) => chaikin(arc.map((p) => [p[0], p[1]])));
topo = quantize(topo, 4e4);
fs.writeFileSync(outPath, JSON.stringify(topo));
console.log(log.join("\n"));
console.log("範圍數", regions.length, "／格數", regions.reduce((a, r) => a + r.cells.size, 0));
for (const r of regions) if (["関東平野", "濃尾平野", "奈良盆地", "飛驒山脈", "武蔵野台地", "奥羽山脈"].includes(r.n)) console.log(r.n, r.cells.size);
