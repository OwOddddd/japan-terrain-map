# 國土數值情報「湖沼」(W09) → 網站用的湖泊多邊形（依名稱篩選、簡化座標）
import json, sys
import shapefile

lake_map = json.load(open(sys.argv[1], encoding="utf-8"))  # 網站湖名 → 官方湖名清單
names = {o: k for k, v in lake_map.items() for o in v}
out_path = sys.argv[2]


def dp(pts, tol):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    L = (dx * dx + dy * dy) ** 0.5 or 1e-12
    best, idx = 0, 0
    for i in range(1, len(pts) - 1):
        x, y = pts[i]
        d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / L
        if d > best:
            best, idx = d, i
    if best > tol:
        return dp(pts[: idx + 1], tol)[:-1] + dp(pts[idx:], tol)
    return [pts[0], pts[-1]]


def ring_simplify(ring, tol):
    # 閉合環：從最遠的兩點切開再簡化
    r = ring[:-1] if ring[0] == ring[-1] else ring
    if len(r) < 8:
        return ring
    far = max(range(len(r)), key=lambda i: (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2)
    a = dp(r[: far + 1], tol)
    b = dp(r[far:] + [r[0]], tol)
    out = a[:-1] + b
    return out if len(out) >= 4 else ring


r = shapefile.Reader("w09/W09-05-g_Lake", encoding="cp932")
fields = [f[0] for f in r.fields[1:]]
found = {}
for sr in r.iterShapeRecords():
    d = dict(zip(fields, sr.record))
    n = str(d["W09_001"]).strip()
    if n not in names:
        continue
    parts = list(sr.shape.parts) + [len(sr.shape.points)]
    rings = [sr.shape.points[parts[i]:parts[i + 1]] for i in range(len(parts) - 1)]
    rings = [[[round(x, 4), round(y, 4)] for x, y in ring_simplify([list(p) for p in rg], 0.0015)] for rg in rings]
    # Shapefile：外環順時針、內環（湖中島）逆時針；內環接在前一個外環後面
    polys = found.setdefault(names[n], [])
    for rg in rings:
        area = sum(rg[i][0] * rg[i + 1][1] - rg[i + 1][0] * rg[i][1] for i in range(len(rg) - 1))
        if area < 0 or not polys:
            polys.append([rg])
        else:
            polys[-1].append(rg)

json.dump({k: {"type": "MultiPolygon", "coordinates": v} for k, v in found.items()},
          open(out_path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("found", len(found), "/", len(lake_map))
print("missing", [n for n in lake_map if n not in found])
