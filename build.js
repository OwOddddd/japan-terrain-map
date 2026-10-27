// node build.js → 產生 japan-terrain.html（Claude Artifact 用）與 index.html（GitHub Pages 用）
const fs = require("fs");
const p = (f) => require("path").join(__dirname, f);
let html = fs.readFileSync(p("src/template.html"), "utf8");
html = html
  .replace("/*__TOPO__*/null", () => fs.readFileSync(p("src/data/japan.topojson"), "utf8").trim())
  .replace("/*__REAL__*/null", () => JSON.stringify({ rivers: JSON.parse(fs.readFileSync(p("src/data/rivers.json"), "utf8")), lakes: JSON.parse(fs.readFileSync(p("src/data/lakes.json"), "utf8"))}))
  .replace("/*__PRECISE__*/null", () => fs.readFileSync(p("src/data/precise.topojson"), "utf8").trim())
  .replace("/*__PREFS__*/null", () => fs.readFileSync(p("src/data/prefs.json"), "utf8").trim())
  // 起伏圖不內嵌（約佔首次傳輸量 6 成），勾選時才從同一資料夾載入
  .replace("/*__RELIEF__*/null", () => JSON.stringify({
    ...JSON.parse(fs.readFileSync(p("src/data/relief.json"), "utf8")),
    img: "relief.png", imgGray: "relief_gray.png",
  }))
  // 日語讀音音檔（tools/voice.js 產生）：索引內嵌，MP3 放在 voice/ 點到時才下載
  .replace("/*__VOICE__*/null", () => fs.readFileSync(p("src/data/voice/voice.json"), "utf8").trim())
  .replace("/*__TERRAIN__*/", () => fs.readFileSync(p("src/terrain.js"), "utf8"));
fs.writeFileSync(p("japan-terrain.html"), html);
for (const f of ["relief.png", "relief_gray.png"]) fs.copyFileSync(p("src/data/" + f), p(f));
fs.mkdirSync(p("voice"), { recursive: true });
for (const f of fs.readdirSync(p("src/data/voice"))) if (f.endsWith(".mp3")) fs.copyFileSync(p("src/data/voice/" + f), p("voice/" + f));

// 一般網頁版：補上 doctype、語系與手機 viewport（template 第一行已有 charset）
fs.writeFileSync(p("index.html"), `<!doctype html>
<html lang="zh-Hant">
${html.replace(/<meta charset="utf-8">\r?\n/, `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="勾選日本教材常見地形，在附縣界的地圖上顯示範圍與振假名地名，點名稱可聽讀音，並可輸出成圖片。">
`)}
</html>
`);
console.log("japan-terrain.html / index.html", (html.length / 1024).toFixed(0) + " KB");
