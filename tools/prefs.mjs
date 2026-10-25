// node prefs.mjs <專案資料夾>  → src/data/prefs.json
// 每個地形涉及哪些都道府縣（只要有一部分在縣內就算）；範圍以精緻版為準
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { geoContains, geoBounds, geoDistance } from "d3-geo";
const require = createRequire(import.meta.url);
const { feature } = require("topojson-client");

const dir = process.argv[2];
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const CATS = new Function(read("src/terrain.js") + ";return CATS")();
const TOPO = JSON.parse(read("src/data/japan.topojson"));
const PT = JSON.parse(read("src/data/precise.topojson"));
const RIVERS = JSON.parse(read("src/data/rivers.json"));
const LAKES = JSON.parse(read("src/data/lakes.json"));

// 平面判定（經緯度範圍小，足夠準確且比球面判定快很多）：每個多邊形分塊並記錄外框
const partsOf = (geom) => (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates).map((rings) => {
  const xs = rings[0].map((q) => q[0]), ys = rings[0].map((q) => q[1]);
  return { rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
});
const ringHas = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const partsHave = (parts, [x, y]) => parts.some((pt) => x >= pt.box[0] && x <= pt.box[2] && y >= pt.box[1] && y <= pt.box[3] && ringHas(pt.rings[0], x, y) && !pt.rings.slice(1).some((h) => ringHas(h, x, y)));
const PREFS = feature(TOPO, TOPO.objects.japan).features.map((f) => ({ id: f.properties.id, f, b: geoBounds(f), parts: partsOf(f.geometry) }));
const PRECISE = new Map(feature(PT, PT.objects.precise).features.map((f) => [f.properties.n, f.geometry]));
const PRECISE_CATS = new Set(["range", "plain", "plateau", "basin"]);

const inBox = (b, [x, y], m = 0) => x >= b[0][0] - m && x <= b[1][0] + m && y >= b[0][1] - m && y <= b[1][1] + m;
const prefAt = (p) => { for (const P of PREFS) if (inBox(P.b, p) && partsHave(P.parts, p)) return P.id; return null; };
// 點不在任何縣內時，找距離 tolKm 以內最近的縣（岬、島、湾等常落在海岸線外）
const verts = new Map(PREFS.map((P) => [P.id, (P.f.geometry.type === "Polygon" ? [P.f.geometry.coordinates] : P.f.geometry.coordinates).flat(2)]));
// 點：所在的縣＋距離 tolKm 以內的所有縣（例如富士山在山梨・靜岡縣界上、東京湾面向三個都縣）
function nearPrefs(p, tolKm) {
  const r = tolKm / 6371, out = [];
  for (const P of PREFS) {
    if (!inBox(P.b, p, tolKm / 80)) continue;
    if (verts.get(P.id).some((v) => geoDistance(p, v) < r)) out.push(P.id);
  }
  return out;
}
// 線：頂點＋每 0.02° 內插點
function lineSamples(lines) {
  const out = [];
  for (const ln of lines) for (let i = 0; i < ln.length - 1; i++) {
    const [a, b] = [ln[i], ln[i + 1]], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.02));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  for (const ln of lines) out.push(ln[ln.length - 1]);
  return out;
}
// 面：邊界頂點＋範圍內每 0.03° 的格點
function polySamples(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  const out = polys.flat(2), parts = partsOf(geom);
  const b = geoBounds(geom);
  for (let x = b[0][0]; x <= b[1][0]; x += 0.03) for (let y = b[0][1]; y <= b[1][1]; y += 0.03) if (partsHave(parts, [x, y])) out.push([x, y]);
  return out;
}
const minDist = (p, id) => Math.min(...verts.get(id).map((v) => geoDistance(p, v)));
const TOL = { volcano: 2, peak: 2, dot: 8, text: 6, water: 20 };
// 縣界資料沒有收錄的離島
const FIXED = { "island:沖ノ鳥島": [13] };

const out = {};
for (const cat of CATS) for (const it of cat.items) {
  const id = cat.id + ":" + it.n, k = cat.kind, set = new Set();
  if (FIXED[id]) { out[id] = FIXED[id]; continue; }
  if (k === "current" || k === "trench" || it.big) { out[id] = []; continue; }
  let samples = null;
  if (PRECISE_CATS.has(cat.id) && PRECISE.has(it.n)) samples = polySamples(PRECISE.get(it.n));
  else if (k === "river") samples = lineSamples(RIVERS[it.n].coordinates);
  else if (k === "lake") samples = polySamples(LAKES[it.n]);
  else if (it.p) samples = polySamples({ type: "Polygon", coordinates: [[...it.p, it.p[0]]] });
  else if (it.s) samples = lineSamples([it.s]);
  if (samples) {
    // 已找到的縣先試，加快判定
    for (const p of samples) {
      let hit = null;
      for (const id2 of set) { const P = PREFS.find((q) => q.id === id2); if (inBox(P.b, p) && partsHave(P.parts, p)) { hit = id2; break; } }
      if (!hit) { const id2 = prefAt(p); if (id2) set.add(id2); }
    }
  } else if (it.c) {
    const id2 = prefAt(it.c);
    if (id2) set.add(id2);
    for (const id3 of nearPrefs(it.c, TOL[k] || 10)) set.add(id3);
    // 標示點離岸較遠（灘、群島的名稱位置）：改取 60 km 內最近的縣
    if (!set.size) { const near = nearPrefs(it.c, 60); if (near.length) set.add(near.sort((x, y) => minDist(it.c, x) - minDist(it.c, y))[0]); }
  }
  out[id] = [...set].sort((a, b) => a - b);
}
fs.writeFileSync(path.join(dir, "src/data/prefs.json"), JSON.stringify(out));
const empty = Object.entries(out).filter(([, v]) => !v.length).map(([k]) => k.split(":")[1]);
console.log("地形數", Object.keys(out).length, "無對應縣：", empty.join(" "));
const name = new Map(PREFS.map((P) => [P.id, P.f.properties.nam_ja]));
for (const n of ["bay:大阪湾", "cape:宗谷岬", "peninsula:能登半島", "island:対馬", "sea:関門海峡", "range:飛驒山脈", "plain:関東平野", "river:利根川", "bay:東京湾", "island:佐渡島", "lake:琵琶湖", "volcano:富士山", "mountain:北岳"])
  console.log(n, (out[n] || []).map((i) => name.get(i)).join("、"));
