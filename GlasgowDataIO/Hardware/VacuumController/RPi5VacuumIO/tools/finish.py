import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcbnew
from genpcb import P, W, H, OX, OY, FIXED
import design
CD = {c["ref"]: c for c in design.C}

def text(b, s, x, y, size=0.8, just=0, rot=0, layer=pcbnew.F_SilkS, bold=False):
    t = pcbnew.PCB_TEXT(b); t.SetText(s); t.SetPosition(P(x, y)); t.SetLayer(layer)
    t.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(size), pcbnew.FromMM(size)))
    t.SetTextThickness(pcbnew.FromMM(0.15 if size < 1.2 else 0.22)); t.SetBold(bold)
    t.SetHorizJustify({-1: pcbnew.GR_TEXT_H_ALIGN_LEFT, 0: pcbnew.GR_TEXT_H_ALIGN_CENTER, 1: pcbnew.GR_TEXT_H_ALIGN_RIGHT}[just])
    if rot: t.SetTextAngleDegrees(rot)
    if layer == pcbnew.B_SilkS: t.SetMirrored(True)
    b.Add(t)

def zone(b, layer, net):
    z = pcbnew.ZONE(b); z.SetLayer(layer); z.SetNet(b.FindNet(net))
    ol = z.Outline(); ol.NewOutline()
    for x, y in [(0.3, 0.3), (W - 0.3, 0.3), (W - 0.3, H - 0.3), (0.3, H - 0.3)]:
        ol.Append(pcbnew.FromMM(OX + x), pcbnew.FromMM(OY + y))
    z.SetLocalClearance(pcbnew.FromMM(0.3)); z.SetMinThickness(pcbnew.FromMM(0.25))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
    z.SetThermalReliefGap(pcbnew.FromMM(0.3)); z.SetThermalReliefSpokeWidth(pcbnew.FromMM(0.35))
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS); b.Add(z)

RELAY_USE = ["MECHANICAL A0", "TURBO A1", "UH PUMP 1 A2", "UH PUMP 2 A3", "HV XFMR A4", "SPARE A5", "SPARE A6", "SPARE A7"]

def main(src, dst):
    b = pcbnew.LoadBoard(src)
    for fp in b.GetFootprints():
        r = fp.GetReference()
        if r.startswith("J") or r.startswith("H"):
            fp.Reference().SetVisible(False)
    # relay contact terminals (rot 180: pin1 = COM on the right)
    for n in range(1, 9):
        x, y, _ = FIXED[f"J{10+n}"]
        for i, lab in enumerate(["COM", "NO", "NC"]):
            text(b, lab, x - 5.08 * i, y - 4.8, 0.7)
        xr = FIXED[f"K{n}"][0]
        text(b, f"K{n} {RELAY_USE[n-1]}", xr, 13.4, 0.7, bold=True)
    # bottom terminals (rot 0: pins run +x)
    for g in range(4):
        x, y, _ = FIXED[f"J{21+g}"]; a, c = 2 * g + 1, 2 * g + 2
        for i, lab in enumerate(["+24", f"V{a}-", "+24", f"V{c}-"]):
            text(b, lab, x + 3.5 * i, y - 3.1, 0.6)
        text(b, f"SOLENOID V{a}/V{c}", x + 5.25, y - 4.6, 0.7)
    for q in range(4):
        x, y, _ = FIXED[f"J{31+q}"]
        labs = [f"DI{4*q+k}" for k in range(1, 5)] + ["COM", "+24"]
        for i, lab in enumerate(labs):
            text(b, lab, x + 3.5 * i, y - 3.1, 0.6)
        title = {0: "READY B0 MECH  B1 TURBO  B2 UH1  B3 UH2", 1: "FAULT  MECH  TURBO  UH1  UH2"}.get(q, f"INPUTS {4*q+1}-{4*q+4}  (COM = 0 V)")
        text(b, title, x + 8.75, y - 4.6, 0.6 if q < 2 else 0.7)
    # right edge (rot 90: pin1 at origin, pins run -y)
    for ref, labs in [("J4", ["485A", "485B", "GND"]), ("J5", ["232TX", "232RX", "GND"]),
                      ("J41", ["AI1", "0V", "AI2", "0V", "AI3", "0V", "AI4", "0V"]),
                      ("J42", ["AI5", "0V", "AI6", "0V", "AI7", "0V", "AI8", "0V"])]:
        x, y, _ = FIXED[ref]
        for i, lab in enumerate(labs):
            text(b, lab, x - 3.0, y - 3.5 * i, 0.6, just=1)
    # left edge (rot 270: pins run +y)
    for ref, labs, title in [("J1", ["+", "-"], "24VDC IN"), ("J2", ["1", "2"], "E-STOP NC LOOP")]:
        x, y, _ = FIXED[ref]
        pitch = 5.08 if ref == "J1" else 3.5
        for i, lab in enumerate(labs):
            text(b, lab, x + 2.5, y + pitch * i, 0.8, just=-1)
        text(b, title, 1.0, y - 3.4, 0.7, just=-1)
    x, y, _ = FIXED["J3"]
    text(b, "TO RASPBERRY PI 5 GPIO (pin 1 = square pad)", x + 24, y + 5.2, 0.8)
    text(b, "RPi5 VACUUM CONTROLLER I/O  rev A.1", 120, 95.5, 1.4, bold=True)
    legend = [
        "CHANNEL MAP = glasgow_service vacuumSystem.json (SBC.Channels / SBC.Gauges)",
        "A0 K1  MechanicalVacuumPump    ready B0=DI1  fault DI5  gauge AI1",
        "A1 K2  TurboVacuumPump         at speed B1=DI2  fault DI6  gauge AI2  speed AI5",
        "A2 K3  UHVacuumPump_1 (turbo)  at speed B2=DI3  fault DI7  gauge AI3  speed AI6",
        "A3 K4  UHVacuumPump_2 (turbo)  at speed B3=DI4  fault DI8  gauge AI4  speed AI7",
        "A4 K5  HighVoltageTransformer  (HV permissive)",
        "RS-485 J4: the three turbo controllers, multi-drop.",
        "K1 on E-STOP rail; K2-K8 and V1-V8 on WATCHDOG rail.",
        "Wiring guide: RPi5VacuumIO/WIRING.md",
    ]
    for i, line in enumerate(legend):
        text(b, line, 140, 61 + 1.5 * i, 0.8, just=-1, layer=pcbnew.B_SilkS)
    text(b, "FEI DB235  |  Ionbeam  2026-09", 120, 97.6, 0.9)
    text(b, "RPi5VacuumIO rev A.1 - relay contacts are NOT for mains pump power", W / 2, H / 2, 1.0, layer=pcbnew.B_SilkS)
    # relay references in the body centre; hide any silk reference that would sit on exposed copper
    for fp in b.GetFootprints():
        if fp.GetReference().startswith("K"):
            fp.Reference().SetPosition(pcbnew.VECTOR2I(fp.GetPosition().x, fp.GetPosition().y + pcbnew.FromMM(8)))
            fp.Reference().SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(1.2), pcbnew.FromMM(1.2)))
    pads = [(p, p.GetBoundingBox()) for p in b.GetPads()]
    hidden = 0
    for fp in b.GetFootprints():
        rf = fp.Reference()
        if not rf.IsVisible():
            continue
        tb = rf.GetBoundingBox(); tb.Inflate(pcbnew.FromMM(0.1))
        if any(tb.Intersects(pb) for p, pb in pads if p.IsOnLayer(pcbnew.F_Cu) or p.IsOnLayer(pcbnew.F_Mask)):
            rf.SetVisible(False); hidden += 1
    print("silk references hidden (still on F.Fab):", hidden)
    ds = b.GetDesignSettings(); ds.SetAuxOrigin(P(0, H)); ds.SetGridOrigin(P(0, H))
    zone(b, pcbnew.F_Cu, "GND"); zone(b, pcbnew.B_Cu, "GND")
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    # Pads whose thermal relief ends up with <2 spokes (tight pitch) get a solid zone connection.
    import re, tempfile
    for _ in range(3):
        rpt = tempfile.mktemp(suffix=".rpt")
        pcbnew.WriteDRCReport(b, rpt, pcbnew.EDA_UNITS_MILLIMETRES, True)
        starved = []
        for block in open(rpt).read().split("\n["):
            if block.startswith("starved_thermal") or block.startswith("[starved_thermal"):
                starved += re.findall(r"Pad (\S+) \[[^\]]*\] of (\S+) on", block)
        if not starved:
            break
        for num, ref in set(starved):
            for p in b.FindFootprintByReference(ref).Pads():
                if p.GetNumber() == num:
                    p.SetZoneConnection(pcbnew.ZONE_CONNECTION_FULL)
        pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(dst)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
