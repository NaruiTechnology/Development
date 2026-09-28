import sys, re, pcbnew
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from sexp import parse, find, find1
def import_ses(board, sesfile):
    t = parse(open(sesfile).read())
    routes = find1(t, "routes")
    res = find1(routes, "resolution"); scale = {"um": 1e-3, "mm": 1.0, "mil": 0.0254}[res[1]] / float(res[2])
    def pt(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(float(x) * scale), pcbnew.FromMM(-float(y) * scale))
    layers = {"F.Cu": pcbnew.F_Cu, "B.Cu": pcbnew.B_Cu}
    ntr = nvia = 0
    for net in find(find1(routes, "network_out"), "net"):
        ni = board.FindNet(net[1])
        for w in find(net, "wire"):
            p = find1(w, "path"); lay = layers[p[1]]; width = float(p[2]) * scale
            xy = p[3:]
            pts = [pt(xy[i], xy[i + 1]) for i in range(0, len(xy) - 1, 2)]
            for a, b in zip(pts, pts[1:]):
                tr = pcbnew.PCB_TRACK(board); tr.SetStart(a); tr.SetEnd(b)
                tr.SetWidth(pcbnew.FromMM(width)); tr.SetLayer(lay); tr.SetNet(ni); board.Add(tr); ntr += 1
        for v in find(net, "via"):
            m = re.search(r"_(\d+):(\d+)_um", v[1]); dia, drill = int(m.group(1)) / 1000, int(m.group(2)) / 1000
            via = pcbnew.PCB_VIA(board); via.SetPosition(pt(v[2], v[3]))
            via.SetWidth(pcbnew.FromMM(dia)); via.SetDrill(pcbnew.FromMM(drill))
            via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu); via.SetNet(ni); board.Add(via); nvia += 1
    return ntr, nvia
if __name__ == "__main__":
    b = pcbnew.LoadBoard(sys.argv[1]); print(import_ses(b, sys.argv[2])); b.Save(sys.argv[3])
