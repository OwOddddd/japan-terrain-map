// node calib_points.js <terrain.js> <gazetteer.csv>
// 以國土地理院「地名集日本」的代表點校正點狀地形與標示位置，寫回 terrain.js
const fs = require("fs");
const [terrainPath, gazPath] = process.argv.slice(2);
const src = fs.readFileSync(terrainPath, "utf8");
const head = src.slice(0, src.indexOf("const CATS"));
const CATS = new Function(src + ";return CATS")();

const gaz = new Map();
for (const line of fs.readFileSync(gazPath, "utf8").trim().split(/\r?\n/).slice(1)) {
  const [kanji, , , lat, lng, cls] = line.split(",");
  if (!gaz.has(kanji)) gaz.set(kanji, []);
  gaz.get(kanji).push({ lat: +lat, lng: +lng, cls });
}
const alts = (n) => [...new Set([n, n.replace(/驒/g, "騨"), n.replace(/騨/g, "驒"), n.replace(/ヶ/g, "ケ"), n.replace(/（.*）/, "")])];
const km = (a, b) => {
  const t = Math.PI / 180, x = (b[0] - a[0]) * t * Math.cos(((a[1] + b[1]) / 2) * t), y = (b[1] - a[1]) * t;
  return 6371 * Math.hypot(x, y);
};
// 類別 → 可接受的最大位移（km），超過視為同名異地
const LIMIT = { volcano: 25, peak: 25, dot: 40, text: 60, water: 60, lake: 25 };
const log = [];
for (const cat of CATS) {
  const lim = LIMIT[cat.kind];
  if (!lim) continue;
  for (const it of cat.items) {
    if (!it.c || it.big) continue;
    let best = null;
    for (const a of alts(it.n)) for (const g of gaz.get(a) || []) {
      const d = km(it.c, [g.lng, g.lat]);
      if (!best || d < best.d) best = { d, g };
    }
    if (!best) continue;
    if (best.d > lim) { log.push(`略過 ${it.n}：最近的同名點相距 ${best.d.toFixed(0)} km`); continue; }
    log.push(`${cat.label}\t${it.n}\t${best.d.toFixed(1)} km`);
    it.c = [best.g.lng, best.g.lat];
    it.src = "gsi";
  }
}

let js = head + "const CATS = [\n";
for (const c of CATS) {
  js += `  { id: ${JSON.stringify(c.id)}, label: ${JSON.stringify(c.label)}, kind: ${JSON.stringify(c.kind)}, color: ${JSON.stringify(c.color)}, items: [\n`;
  for (const it of c.items) js += "    " + JSON.stringify(it).replace(/"(\w+)":/g, "$1: ") + ",\n";
  js += "  ]},\n";
}
fs.writeFileSync(terrainPath, js + "];\n");
console.log(log.join("\n"));
console.log("校正筆數", log.filter((l) => !l.startsWith("略過")).length);
