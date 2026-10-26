# 國土地理院「標高タイル」(dem_png, z8) → 色別標高＋陰影的全國起伏圖（Web Mercator，可直接疊在 d3.geoMercator 上）
# python relief.py fetch   下載圖磚到 dem8/
# python relief.py build <scale> <out.png> <out.json>   合成並輸出圖片與四角經緯度
import io, json, math, os, sys, time, urllib.request
import numpy as np
from PIL import Image

Z = 8
X0, X1, Y0, Y1 = 215, 233, 90, 110  # 經度約 122.3–149.1、緯度約 23.6–46.6
URL = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"


def fetch():
    os.makedirs("dem8", exist_ok=True)
    got = miss = 0
    for x in range(X0, X1 + 1):
        for y in range(Y0, Y1 + 1):
            p = f"dem8/{x}_{y}.png"
            if os.path.exists(p) or os.path.exists(p + ".none"):
                continue
            try:
                data = urllib.request.urlopen(URL.format(z=Z, x=x, y=y), timeout=30).read()
                open(p, "wb").write(data); got += 1
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    open(p + ".none", "w").close(); miss += 1
                else:
                    raise
            time.sleep(0.05)
    print("downloaded", got, "no-data", miss)


def lat_of(ty):  # 圖磚上緣（像素 y 也可用：ty = 像素 / 256）
    n = math.pi - 2 * math.pi * ty / 2 ** Z
    return math.degrees(math.atan(math.sinh(n)))


# 色別標高：標高(m) → 顏色（低地綠 → 黃 → 褐 → 高山白）
STOPS = [(0, (126, 186, 118)), (100, (170, 208, 132)), (300, (226, 226, 150)), (600, (226, 196, 120)),
         (1000, (200, 150, 92)), (1500, (166, 112, 72)), (2000, (140, 96, 80)), (2500, (170, 150, 140)), (3000, (240, 236, 232))]


# 灰階版：亮度隨標高單調變暗（低地淺、高山深），疊色後平野仍清楚
GRAY_STOPS = [(0, 238), (100, 226), (300, 208), (600, 186), (1000, 160), (1500, 132), (2000, 108), (2500, 88), (3000, 70)]


def colorize(h):
    out = np.zeros(h.shape + (3,), np.float32)
    hs = np.clip(h, 0, None)
    for k in range(3):
        xs = [s[0] for s in STOPS]; ys = [s[1][k] for s in STOPS]
        out[..., k] = np.interp(hs, xs, ys).astype(np.float32)
    return out


def build(scale, out_png, out_json):
    W, H = (X1 - X0 + 1) * 256, (Y1 - Y0 + 1) * 256
    h = np.full((H, W), np.nan, np.float32)
    for x in range(X0, X1 + 1):
        for y in range(Y0, Y1 + 1):
            p = f"dem8/{x}_{y}.png"
            if not os.path.exists(p):
                continue
            a = np.asarray(Image.open(p).convert("RGB")).astype(np.int64)
            v = a[..., 0] * 65536 + a[..., 1] * 256 + a[..., 2]
            m = np.where(v == 2 ** 23, np.nan, np.where(v < 2 ** 23, v * 0.01, (v - 2 ** 24) * 0.01)).astype(np.float32)
            h[(y - Y0) * 256:(y - Y0 + 1) * 256, (x - X0) * 256:(x - X0 + 1) * 256] = m
    land = ~np.isnan(h) & (np.nan_to_num(h) > -50)
    hz = np.nan_to_num(h, nan=0.0)
    del h
    # 32 位元 Python 記憶體有限：先把標高與陸地遮罩縮到輸出尺寸再上色
    if scale != 1:
        size = (int(W * scale), int(H * scale))
        hz = np.asarray(Image.fromarray(hz.astype(np.float32), "F").resize(size, Image.BILINEAR), np.float32)
        land = np.asarray(Image.fromarray((land * 255).astype(np.uint8), "L").resize(size, Image.BILINEAR)) > 127
        W, H = size
    # 陰影：西北光源
    px_m = 40075016 / (256 * 2 ** Z) / scale  # 一個像素約幾公尺（Mercator 下各緯度略有差異，對陰影外觀影響不大）
    az, alt = math.radians(315), math.radians(45)
    rgba = np.zeros((H, W, 4), np.uint8)
    rgba[..., 3] = (land * 255).astype(np.uint8)
    gray = rgba.copy()
    # 分段處理（每段前後多取 1 列讓梯度連續），避免 32 位元 Python 記憶體不足
    step = 400
    for r0 in range(0, H, step):
        a, b = max(0, r0 - 1), min(H, r0 + step + 1)
        part = hz[a:b]
        gy, gx = np.gradient(part, px_m * 0.75)
        slope = np.arctan(np.hypot(gx, gy) * 1.8)
        aspect = np.arctan2(-gx, gy)
        shade = np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1).astype(np.float32)
        rgb = colorize(part) * (0.55 + 0.45 * shade[..., None])
        lo, hi = r0 - a, r0 - a + min(step, H - r0)
        rgba[r0:r0 + (hi - lo), :, :3] = np.clip(rgb[lo:hi], 0, 255).astype(np.uint8)
        g = np.interp(np.clip(part, 0, None), [t[0] for t in GRAY_STOPS], [t[1] for t in GRAY_STOPS]) * (0.6 + 0.4 * shade)
        gray[r0:r0 + (hi - lo), :, :3] = np.clip(g[lo:hi], 0, 255).astype(np.uint8)[..., None]
    img = Image.fromarray(rgba, "RGBA")
    img = img.quantize(colors=128, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    img.save(out_png, optimize=True)
    gimg = Image.fromarray(gray, "RGBA").quantize(colors=48, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    gimg.save(out_png.replace(".png", "_gray.png"), optimize=True)
    lon0, lon1 = X0 / 2 ** Z * 360 - 180, (X1 + 1) / 2 ** Z * 360 - 180
    json.dump({"west": lon0, "east": lon1, "north": lat_of(Y0), "south": lat_of(Y1 + 1),
               "stops": [[s[0], "#%02x%02x%02x" % s[1]] for s in STOPS],
               "grayStops": [[s[0], "#%02x%02x%02x" % ((s[1],) * 3)] for s in GRAY_STOPS]}, open(out_json, "w"))
    print(out_png, img.size, os.path.getsize(out_png) // 1024, "KB")


if sys.argv[1] == "fetch":
    fetch()
else:
    build(float(sys.argv[2]), sys.argv[3], sys.argv[4])
