// node voice.js <terrain.js> <輸出資料夾>   （需先開啟 VOICEVOX，引擎在 127.0.0.1:50021；需要 npm 套件 lamejs）
// 用 VOICEVOX「剣崎雌雄」朗讀每個地形的假名讀音（不讀漢字，避免地名讀錯），
// 同一類別接成一個 MP3（每筆之間留 0.3 秒靜音），另存每筆的起點與長度 → voice.json
const fs = require("fs"), path = require("path");
// lamejs 的模組版在 Node 會出錯（MPEGMode is not defined），改載入它附的單檔版 lame.all.js
const lamejs = new Function(fs.readFileSync(require.resolve("lamejs/lame.all.js"), "utf8") + ";return lamejs;")();
const [terrainPath, outDir] = process.argv.slice(2);
const CATS = new Function(fs.readFileSync(terrainPath, "utf8") + ";return CATS")();
const API = "http://127.0.0.1:50021", SPEAKER = 21, RATE = 24000, GAP = Math.round(RATE * 0.3);

async function synth(text) {
  const q = await (await fetch(`${API}/audio_query?speaker=${SPEAKER}&text=${encodeURIComponent(text)}`, { method: "POST" })).json();
  Object.assign(q, { speedScale: 0.95, prePhonemeLength: 0.05, postPhonemeLength: 0.1, outputSamplingRate: RATE, outputStereo: false });
  const wav = Buffer.from(await (await fetch(`${API}/synthesis?speaker=${SPEAKER}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q) })).arrayBuffer());
  // WAV：找 data 區塊（16 bit 單聲道）
  let o = 12;
  while (wav.toString("ascii", o, o + 4) !== "data") o += 8 + wav.readUInt32LE(o + 4);
  const n = wav.readUInt32LE(o + 4) / 2, pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = wav.readInt16LE(o + 8 + i * 2);
  return pcm;
}
function mp3(pcm) {
  const enc = new lamejs.Mp3Encoder(1, RATE, 40), out = [];
  for (let i = 0; i < pcm.length; i += 1152) { const b = enc.encodeBuffer(pcm.subarray(i, i + 1152)); if (b.length) out.push(Buffer.from(b)); }
  const e = enc.flush(); if (e.length) out.push(Buffer.from(e));
  return Buffer.concat(out);
}
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const index = {};
  for (const cat of CATS) {
    const parts = [], at = [];
    let len = GAP;
    parts.push(new Int16Array(GAP));
    for (const it of cat.items) {
      // 讀音中的「、」（例：おおぼけ、こぼけ）保留為停頓
      const pcm = await synth(it.k);
      at.push([it.i, len / RATE, pcm.length / RATE]);
      parts.push(pcm, new Int16Array(GAP)); len += pcm.length + GAP;
    }
    const all = new Int16Array(len);
    let p = 0; for (const a of parts) { all.set(a, p); p += a.length; }
    const buf = mp3(all);
    fs.writeFileSync(path.join(outDir, cat.id + ".mp3"), buf);
    for (const [i, s, d] of at) index[i] = [cat.id, +s.toFixed(3), +d.toFixed(3)];
    console.log(cat.id, cat.items.length, "筆", (buf.length / 1024).toFixed(0), "KB");
  }
  fs.writeFileSync(path.join(outDir, "voice.json"), JSON.stringify(index));
})();
