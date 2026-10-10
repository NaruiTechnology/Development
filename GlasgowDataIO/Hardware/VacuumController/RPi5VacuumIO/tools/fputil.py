import pcbnew
FPDIR = "/usr/share/kicad/footprints"
def load(fpid):
    lib, name = fpid.split(":")
    fp = pcbnew.FootprintLoad(f"{FPDIR}/{lib}.pretty", name); fp.SetFPID(pcbnew.LIB_ID(lib, name)); return fp
def crt_bbox(fp):
    """Courtyard bbox (mm) relative to footprint origin, honouring current orientation."""
    xs, ys = [], []
    for it in fp.GraphicalItems():
        if it.GetLayer() in (pcbnew.F_CrtYd, pcbnew.B_CrtYd):
            b = it.GetBoundingBox(); xs += [b.GetLeft(), b.GetRight()]; ys += [b.GetTop(), b.GetBottom()]
    if not xs:
        for p in fp.Pads():
            b = p.GetBoundingBox(); xs += [b.GetLeft(), b.GetRight()]; ys += [b.GetTop(), b.GetBottom()]
    o = fp.GetPosition()
    return [pcbnew.ToMM(min(xs) - o.x), pcbnew.ToMM(min(ys) - o.y), pcbnew.ToMM(max(xs) - o.x), pcbnew.ToMM(max(ys) - o.y)]
