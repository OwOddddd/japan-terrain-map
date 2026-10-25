// node build.js → 產生 japan-terrain.html（Claude Artifact 用）與 index.html（GitHub Pages 用）
const fs = require("fs");
const p = (f) => require("path").join(__dirname, f);
let html = fs.readFileSync(p("src/template.html"), "utf8");
html = html
  .replace("/*__TOPO__*/null", () => fs.readFileSync(p("src/data/japan.topojson"), "utf8").trim())
  .replace("/*__NE__*/null", () => fs.readFileSync(p("src/data/ne.json"), "utf8").trim())
  .replace("/*__TERRAIN__*/", () => fs.readFileSync(p("src/terrain.js"), "utf8"));
fs.writeFileSync(p("japan-terrain.html"), html);

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
