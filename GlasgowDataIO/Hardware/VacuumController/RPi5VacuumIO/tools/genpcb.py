"""Place all footprints for the RPi5 Vacuum I/O board (connectors at edges, groups shelf-packed)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcbnew, design, fputil
from ids import U
OX, OY = 100.0, 100.0
W, H = 195.0, 160.0
def P(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(OX + x), pcbnew.FromMM(OY + y))
CD = {c["ref"]: c for c in design.C if not c["ref"].startswith("#")}

FIXED = {"H1": (3.5, 3.5, 0), "H2": (W - 3.5, 3.5, 0), "H3": (W - 3.5, H - 3.5, 0), "H4": (3.5, H - 3.5, 0)}
for n in range(1, 9):
    xn = 16.8 + (n - 1) * 23
    FIXED[f"J{10+n}"] = (xn + 5.08, 10.53, 180)       # relay contact terminal, top edge
    FIXED[f"K{n}"] = (xn, 16.0, 0)                   # relay
FIXED.update({
    "J1": (10.53, 50.0, 270), "J2": (8.53, 66.0, 270),                  # left edge: power, E-stop
    "K9": (50.0, 57.0, 90), "K10": (50.0, 76.0, 90),                    # rail relays (horizontal)
    "J3": (130.0, 52.0, 90),                                            # Pi ribbon header
    "J4": (W - 8.53, 70.0, 90), "J5": (W - 8.53, 85.0, 90),            # right edge serial (pins run -y)
    "J41": (W - 8.53, 118.0, 90), "J42": (W - 8.53, 149.5, 90),   # right edge analog
})
for i in range(4): FIXED[f"J{21+i}"] = (11 + i * 18, H - 8.53, 0)        # solenoid terminals, bottom
for i in range(4): FIXED[f"J{31+i}"] = (84 + i * 25, H - 8.53, 0)        # input terminals, bottom

def chan(n): return [f"JP{n}", f"R{30+n}", f"D{20+n}"]
REGIONS = []
for n in range(1, 9):
    xn = 16.8 + (n - 1) * 23
    REGIONS.append(((xn - 10, 37.0, xn + 10, 46.0), chan(n)))
REGIONS += [
    ((14.0, 47.0, 38.0, 88.0), ["F1", "D1", "D2", "C1", "C2", "F2", "R1", "D3", "C3"]),
    ((71.0, 47.0, 97.0, 88.0), ["D4", "D5", "Q9", "R2", "C4", "D6", "C5", "R3", "D7", "D8", "C6", "C7",
                                 "R4", "D9", "R5", "D10", "U13", "R6", "R7", "R8", "R9"]),
    ((99.0, 58.0, 150.0, 88.0), ["U1", "C8", "U2"] + [f"R{20+n}" for n in range(1, 9)] + ["R10", "R11", "D11"]),
    ((152.0, 58.0, 183.0, 88.0), ["U11", "C12", "R14", "R15", "R16", "R17", "JP9", "D12", "D13",
                                   "U12", "C13", "C14", "C15", "C16", "C17"]),
    ((3.0, 90.0, 66.0, 148.5), [x for n in range(1, 9) for x in (f"Q{n}", f"R{40+n}", f"R{50+n}", f"D{30+n}", f"R{60+n}", f"D{40+n}")]),
    ((68.0, 90.0, 150.0, 148.5), ["U3", "C9", "R12"] + [x for q in range(4) for x in
        [f"U{5+q}"] + [y for n in range(4*q+1, 4*q+5) for y in (f"R{100+n}", f"D{100+n}", f"D{120+n}", f"R{120+n}")]]),
    ((152.0, 90.0, 183.0, 148.5), ["U9", "U10", "C10", "C11", "R13"] + [x for n in range(1, 9) for x in
        (f"R{140+n}", f"R{150+n}", f"C{20+n}", f"D{60+n}")]),
]

def build(out):
    b = pcbnew.BOARD(); b.SetCopperLayerCount(2)
    nets = {}
    def net(n):
        if n not in nets:
            ni = pcbnew.NETINFO_ITEM(b, n); b.Add(ni); nets[n] = ni
        return nets[n]
    fps = {}
    for ref, c in CD.items():
        fp = fputil.load(c["fp"]); fp.SetReference(ref); fp.SetValue(c["value"])
        fp.SetPath(pcbnew.KIID_PATH("/" + U("sym", ref, c["units"][0])))
        rf = fp.Reference(); rf.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
        rf.SetTextThickness(pcbnew.FromMM(0.12)); fp.Value().SetLayer(pcbnew.F_Fab)
        for pad in fp.Pads():
            nn = c["pins"].get(pad.GetNumber())
            if nn and nn != "NC": pad.SetNet(net(nn))
        if ref.startswith("H"): fp.SetAttributes(pcbnew.FP_EXCLUDE_FROM_BOM | pcbnew.FP_EXCLUDE_FROM_POS_FILES)
        fps[ref] = fp; b.Add(fp)
    boxes = []
    for ref, (x, y, r) in FIXED.items():
        fp = fps[ref]; fp.SetOrientationDegrees(r); fp.SetPosition(P(x, y))
        l, t, rr, bt = fputil.crt_bbox(fp); boxes.append((ref, x + l, y + t, x + rr, y + bt))
    done = set(FIXED)
    for (x0, y0, x1, y1), refs in REGIONS:
        cx, cy, rowh = x0, y0, 0.0
        for ref in refs:
            fp = fps[ref]; fp.SetOrientationDegrees(0)
            l, t, rr, bt = fputil.crt_bbox(fp); w, h = rr - l, bt - t
            if cx + w > x1:
                cx, cy, rowh = x0, cy + rowh + 0.4, 0.0
            if cy + h > y1:
                raise SystemExit(f"region full at {ref} ({x0},{y0},{x1},{y1})")
            px, py = cx - l, cy - t
            fp.SetPosition(P(px, py)); boxes.append((ref, cx, cy, cx + w, cy + h))
            cx += w + 0.4; rowh = max(rowh, h); done.add(ref)
    missing = set(CD) - done
    if missing: raise SystemExit(f"unplaced: {sorted(missing)}")
    # overlap check
    bad = 0
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, c2 = boxes[i], boxes[j]
            if a[1] < c2[3] - 0.01 and c2[1] < a[3] - 0.01 and a[2] < c2[4] - 0.01 and c2[2] < a[4] - 0.01:
                print("overlap", a[0], c2[0]); bad += 1
    for ref, l, t, r, bt in boxes:
        if l < -0.01 or t < -0.01 or r > W + 0.01 or bt > H + 0.01: print("outside", ref, round(l,1), round(t,1), round(r,1), round(bt,1)); bad += 1
    pts = [(0, 0), (W, 0), (W, H), (0, H)]
    for i in range(4):
        s = pcbnew.PCB_SHAPE(b); s.SetShape(pcbnew.SHAPE_T_SEGMENT); s.SetStart(P(*pts[i])); s.SetEnd(P(*pts[(i + 1) % 4]))
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(pcbnew.FromMM(0.1)); b.Add(s)
    b.Save(out); print("placed", len(fps), "footprints;", bad, "placement problems")
    return bad
if __name__ == "__main__":
    sys.exit(1 if build(sys.argv[1]) else 0)
