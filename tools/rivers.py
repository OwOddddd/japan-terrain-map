# 國土數值情報「河川」(W05) → 網站用的河道線
# 做法：用河川名＋手繪位置找到該河川的「河川コード」，再取出同一コード的全部流路（跨縣也能接上）
import glob, json, math, sys
import shapefile

ref = json.load(open(sys.argv[1], encoding="utf-8"))  # {網站河名: [[lon,lat],...] 參考線}
out_path = sys.argv[2]


def km(a, b):
    t = math.pi / 180
    x = (b[0] - a[0]) * t * math.cos((a[1] + b[1]) / 2 * t)
    y = (b[1] - a[1]) * t
    return 6371 * math.hypot(x, y)


def dist_to_line(p, line):
    best = 1e9
    for i in range(len(line) - 1):
        a, b = line[i], line[i + 1]
        # 在經緯度上用線性內插取樣（參考線本身就粗略，足夠）
        for j in range(11):
            q = [a[0] + (b[0] - a[0]) * j / 10, a[1] + (b[1] - a[1]) * j / 10]
            best = min(best, km(p, q))
    return best


segs = []  # (水系コード, 河川コード, 名稱, points)
for f in glob.glob("w05/**/*_Stream.shp", recursive=True):
    r = shapefile.Reader(f, encoding="cp932")
    for sr in r.iterShapeRecords():
        rec = sr.record
        segs.append((rec[0], rec[1], str(rec[3]).strip(), sr.shape.points))
print("segments", len(segs))

# 官方資料使用的別名（四万十川的法定名稱過去為「渡川」）
ALIAS = {"四万十川": ["渡川"]}
result, report = {}, []
for name, line in ref.items():
    names = {name, name.replace("ヶ", "ケ"), name.replace("の", "ノ")} | set(ALIAS.get(name, []))
    cand = {}
    for s in segs:
        if s[2] not in names:
            continue
        mid = s[3][len(s[3]) // 2]
        if dist_to_line(mid, line) > 40:
            continue
        cand[s[1]] = cand.get(s[1], 0) + 1
    if not cand:
        report.append(f"{name}: 找不到")
        continue
    code = max(cand, key=lambda c: (cand[c], c.endswith("0001")))
    parts = [s[3] for s in segs if s[1] == code]
    names_used = sorted({s[2] for s in segs if s[1] == code})
    result[name] = parts
    report.append(f"{name}: 河川コード {code}，{len(parts)} 段，名稱 {'/'.join(names_used)}")


def chain(parts):
    # 依端點把流路段接成較長的線
    lines = [list(map(list, p)) for p in parts if len(p) >= 2]
    key = lambda p: (round(p[0], 5), round(p[1], 5))
    merged = True
    while merged:
        merged = False
        ends = {}
        for i, l in enumerate(lines):
            ends.setdefault(key(l[0]), []).append((i, 0))
            ends.setdefault(key(l[-1]), []).append((i, 1))
        for k, lst in ends.items():
            if len(lst) == 2 and lst[0][0] != lst[1][0]:
                (i, ei), (j, ej) = lst
                a, b = lines[i], lines[j]
                if ei == 0: a = a[::-1]
                if ej == 1: b = b[::-1]
                lines[i] = a + b[1:]
                lines.pop(j)
                merged = True
                break
    return lines


def dp(pts, tol):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy) or 1e-12
    best, idx = 0, 0
    for i in range(1, len(pts) - 1):
        d = abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / L
        if d > best:
            best, idx = d, i
    if best > tol:
        return dp(pts[: idx + 1], tol)[:-1] + dp(pts[idx:], tol)
    return [pts[0], pts[-1]]


sys.setrecursionlimit(100000)
out = {}
for name, parts in result.items():
    lines = [[[round(x, 4), round(y, 4)] for x, y in dp(l, 0.002)] for l in chain(parts)]
    out[name] = {"type": "MultiLineString", "coordinates": [l for l in lines if len(l) >= 2]}
json.dump(out, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("\n".join(report))
