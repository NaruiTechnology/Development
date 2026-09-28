"""Emit a label-connected KiCad schematic from design.py (KiCad 7 format, opens in 7-10)."""
import sys, os
from sexp import parse, dump, find, find1, Sym
import sexp, design
from ids import U, ROOT

PROJECT = "RPi5VacuumIO"
TITLE = "Raspberry Pi 5 Vacuum Controller I/O - FEI DB235"
PAPER, PW, PH = "A0", 1189, 841
HERE = os.path.dirname(os.path.abspath(__file__))
_local = parse(open(os.path.join(HERE, "VacuumIO.kicad_sym")).read()) if os.path.exists(os.path.join(HERE, "VacuumIO.kicad_sym")) else [None]

def get_symbol(libid):
    return sexp.flat_symbol(libid)

def unit_pins(libid):
    s = get_symbol(libid); out = {}
    for sub in find(s, "symbol"):
        _, u, st = sub[1].rsplit("_", 2)
        if int(st) not in (0, 1): continue
        for p in find(sub, "pin"):
            at = find1(p, "at")
            out.setdefault(int(u), []).append((find1(p, "number")[1], float(at[1]), float(at[2]), int(float(at[3]))))
    return out

def g(v, step=1.27): return round(round(v / step) * step, 2)
CD = {c["ref"]: c for c in design.C}
def units(ref): return [(ref, u) for u in CD[ref]["units"]]
def refs(*names): return [(r, u) for r in names for (_, u) in units(r)]
def rng(prefix, a, b): return [f"{prefix}{i}" for i in range(a, b + 1)]

BLOCKS = [
 ("POWER INPUT 24 V", refs("J1", "F1", "D1", "D2", "C1", "C2", "F2", "R1", "D3", "C3", "#FLG01", "#FLG02", "#FLG03")),
 ("E-STOP + WATCHDOG OUTPUT RAILS", refs("J2", "K9", "D4", "K10", "D5", "Q9", "R2", "C4", "D6", "C5", "R3",
     "D7", "D8", "C6", "C7", "R4", "D9", "R5", "D10", "#FLG04", "#FLG05", "U13", "R6", "R7", "R8", "R9")),
 ("RASPBERRY PI 5 HEADER", refs("J3", "R10", "R11", "D11")),
 ("OUTPUT EXPANDER + RELAY DRIVER", refs("U1", "C8", "U2", *rng("R", 21, 28))),
] + [(f"RELAY K{n}", refs(f"K{n}", f"JP{n}", f"R{30+n}", f"D{20+n}", f"J{10+n}")) for n in range(1, 9)] + [
 ("SOLENOID DRIVERS (valves, cylinders)", refs(*[x for n in range(1, 9) for x in (f"R{40+n}", f"R{50+n}", f"Q{n}", f"D{30+n}", f"R{60+n}", f"D{40+n}")], "J21", "J22", "J23", "J24")),
 ("INPUT EXPANDER", refs("U3", "C9", "R12")),
] + [(f"ISOLATED INPUTS {4*q+1}-{4*q+4}", refs(f"U{5+q}", f"J{31+q}", *[x for n in range(4*q+1, 4*q+5) for x in (f"R{100+n}", f"D{100+n}", f"D{120+n}", f"R{120+n}")])) for q in range(4)] + [
 ("GAUGE / ANALOG INPUTS 0-10 V", refs("U9", "U10", "C10", "C11", "R13", *[x for n in range(1, 9) for x in (f"R{140+n}", f"R{150+n}", f"C{20+n}", f"D{60+n}")], "J41", "J42")),
 ("RS-485 (turbo pump controllers, multi-drop)", refs("U11", "C12", "R14", "R15", "R16", "R17", "JP9", "D12", "D13", "J4")),
 ("RS-232", refs("U12", "C13", "C14", "C15", "C16", "C17", "J5")),
 ("MECHANICAL", refs("H1", "H2", "H3", "H4")),
]
placed = {r for _, items in BLOCKS for r, _ in items}
missing = [c["ref"] for c in design.C if c["ref"] not in placed]
assert not missing, missing

WIRE = 2.54
def outward(a):
    dx, dy = {0: (1, 0), 90: (0, 1), 180: (-1, 0), 270: (0, -1)}[a]
    return (-dx, dy)

def bbox(ref, u):
    c = CD[ref]; up = unit_pins(c["lib"])
    pins = up.get(u, []) + up.get(0, [])
    xs, ys = [-5.08, 5.08], [-5.08, 5.08]
    for num, x, y, a in pins:
        net = c["pins"].get(num, "NC"); ox, oy = outward(a)
        L = WIRE + (0 if net == "NC" else len(net) * 1.0 + 1.5)
        xs += [x, x + ox * L]; ys += [-y, -y + oy * L]
    return min(xs), min(ys), max(xs), max(ys)

# flow layout: blocks placed left-to-right in rows; items flow in columns inside a block
MARGIN, BH_MAX = 20, 150
placements, block_frames = {}, []
bx, by, row_h = MARGIN, MARGIN + 5, 0
for title, items in BLOCKS:
    # pre-compute block columns
    cols, col, ch, maxh = [], [], 0, 0
    for ref, u in items:
        x1, y1, x2, y2 = bbox(ref, u); h = y2 - y1 + 6
        if ch + h > BH_MAX and col:
            cols.append(col); col, ch = [], 0
        col.append((ref, u, x1, y1, x2, y2)); ch += h; maxh = max(maxh, ch)
    if col: cols.append(col)
    widths = [max(e[4] - e[2] for e in c) + 6 for c in cols]
    bw, bh = sum(widths) + 6, max(sum(e[5] - e[3] + 6 for e in c) for c in cols) + 14
    if bx + bw > PW - MARGIN:
        bx, by, row_h = MARGIN, by + row_h + 6, 0
    cx = bx + 3
    for c, w in zip(cols, widths):
        cy = by + 12
        for ref, u, x1, y1, x2, y2 in c:
            placements[(ref, u)] = (g(cx - x1, 2.54), g(cy - y1, 2.54))
            cy += y2 - y1 + 6
        cx += w
    block_frames.append((title, bx, by, bw, bh))
    bx += bw + 6; row_h = max(row_h, bh)
if by + row_h > PH - 60:
    print("WARNING: schematic taller than sheet", by + row_h)

out = [Sym("kicad_sch"), [Sym("version"), Sym("20230121")], [Sym("generator"), Sym("eeschema")],
       [Sym("uuid"), Sym(ROOT)], [Sym("paper"), PAPER],
       [Sym("title_block"), [Sym("title"), TITLE], [Sym("date"), "2026-09-28"], [Sym("rev"), "A.1"],
        [Sym("company"), "Ionbeam"],
        [Sym("comment"), 1, "Generated from tools/design.py - label-connected nets"],
        [Sym("comment"), 2, "Outputs are OFF whenever the Pi is absent, booting, or stops its heartbeat"]]]
lib = [Sym("lib_symbols")]
for libid in sorted({c["lib"] for c in design.C}):
    s = list(get_symbol(libid)); s[1] = libid; lib.append(s)
out.append(lib)

def eff(hide=False, just=None, size=1.27, bold=False):
    f = [Sym("font"), [Sym("size"), size, size]] + ([Sym("bold")] if bold else [])
    e = [Sym("effects"), f]
    if just: e.append([Sym("justify")] + [Sym(j) for j in just])
    if hide: e.append(Sym("hide"))
    return e

items = []
for title, x, y, w, h in block_frames:
    items.append([Sym("text"), title, [Sym("at"), g(x + 2), g(y + 6), 0], eff(just=["left", "bottom"], size=2, bold=True),
                  [Sym("uuid"), Sym(U("t", title))]])
    items.append([Sym("rectangle"), [Sym("start"), g(x), g(y)], [Sym("end"), g(x + w), g(y + h)],
                  [Sym("stroke"), [Sym("width"), 0.2], [Sym("type"), Sym("dash")]], [Sym("fill"), [Sym("type"), Sym("none")]],
                  [Sym("uuid"), Sym(U("rect", title))]])
for c in design.C:
    up = unit_pins(c["lib"])
    for u in c["units"]:
        X, Y = placements[(c["ref"], u)]
        pins = up.get(u, []) + up.get(0, [])
        pwr = c["ref"].startswith("#")
        sym = [Sym("symbol"), [Sym("lib_id"), c["lib"]], [Sym("at"), X, Y, 0], [Sym("unit"), u],
               [Sym("in_bom"), Sym("no" if pwr or c["ref"].startswith("H") else "yes")],
               [Sym("on_board"), Sym("no" if pwr else "yes")], [Sym("dnp"), Sym("no")],
               [Sym("uuid"), Sym(U("sym", c["ref"], u))]]
        ys = [-p[2] for p in pins] or [0]
        props = [("Reference", c["ref"], X + 2.54, Y + min(ys) - 2.54, pwr), ("Value", c["value"], X + 2.54, Y + max(ys) + 2.54, pwr),
                 ("Footprint", c["fp"], X, Y, True), ("Datasheet", "~", X, Y, True),
                 ("MPN", c["mpn"], X, Y, True), ("Description", c["desc"], X, Y, True)]
        for i, (k, v, px, py, hid) in enumerate(props):
            sym.append([Sym("property"), k, v, [Sym("id"), i], [Sym("at"), g(px), g(py), 0], eff(hid, ["left"])])
        for num, *_ in pins:
            sym.append([Sym("pin"), num, [Sym("uuid"), Sym(U("pin", c["ref"], u, num))]])
        sym.append([Sym("instances"), [Sym("project"), PROJECT, [Sym("path"), "/" + ROOT, [Sym("reference"), c["ref"]], [Sym("unit"), u]]]])
        items.append(sym)
        for num, x, y, a in pins:
            net = c["pins"].get(num)
            if net is None: sys.exit(f"{c['ref']} pin {num} unassigned")
            px, py = g(X + x), g(Y - y)
            if net == "NC":
                items.append([Sym("no_connect"), [Sym("at"), px, py], [Sym("uuid"), Sym(U("nc", c["ref"], u, num))]]); continue
            ox, oy = outward(a); ex, ey = g(px + ox * WIRE), g(py + oy * WIRE)
            items.append([Sym("wire"), [Sym("pts"), [Sym("xy"), px, py], [Sym("xy"), ex, ey]],
                          [Sym("stroke"), [Sym("width"), 0], [Sym("type"), Sym("default")]], [Sym("uuid"), Sym(U("w", c["ref"], u, num))]])
            ang, just = {(1, 0): (0, ["left", "bottom"]), (-1, 0): (180, ["right", "bottom"]),
                         (0, -1): (90, ["left", "bottom"]), (0, 1): (270, ["right", "bottom"])}[(ox, oy)]
            items.append([Sym("label"), net, [Sym("at"), ex, ey, ang], [Sym("fields_autoplaced")],
                          eff(just=just), [Sym("uuid"), Sym(U("l", c["ref"], u, num))]])
NOTES = ("DESIGN NOTES\n"
 "1. Output power: +24V -> K9 (closed only while the E-stop loop J2 is closed) -> +24V_ESTOP -> K10 (closed only while\n"
 "   the Pi toggles GPIO19 at >= 500 Hz; charge pump blocks DC so a hung or rebooting Pi drops it in ~100 ms) -> +24V_SAFE.\n"
 "2. Solenoid valves/cylinders are powered from +24V_SAFE only. Relay coils select their rail with JP1-JP8:\n"
 "   default K1 (mechanical pump) on +24V_ESTOP so the backing pump keeps running if the Pi hangs; K2-K8 on +24V_SAFE.\n"
 "3. All MCP23017 outputs are held in reset by R10 until the Pi drives GPIO22 high; every driver input has a pull-down.\n"
 "4. The Pi 5 V pins are NOT connected. Board logic runs from the Pi 3V3 pin (< 60 mA). Power the Pi from its own USB-C supply.\n"
 "5. K9 is a standard relay, not a safety relay. For a category-rated E-stop, wire the safety relay output into J2.\n"
 "6. Relay contacts are for permissive/remote inputs of the tool's own pump controllers - not for pump mains power.\n"
 "7. Inputs: 24 V sourcing sensors or dry contacts between +24V_AUX and DIn; DI_COM of each group to 0 V of that supply.\n"
 "8. Analog: 0-10.5 V into 90k; ADC sees Vin x 0.2444 (PGA +/-4.096 V). Calibrate per gauge in software.\n"
 "9. I2C: U1 outputs 0x20, U3 inputs 0x21, U9 ADC 0x48, U10 ADC 0x49 (Pi I2C1, GPIO2/3).\n"
 "10. UART0 GPIO14/15 = RS-485 (DE = GPIO18).  UART4 GPIO12/13 = RS-232 (dtoverlay=uart4-pi5).\n"
 "11. Channel map = glasgow_service vacuumSystem.json / SBC Vacuum Controller dashboard:\n"
 "    A0 K1 MechanicalVacuumPump (ready B0=DI1, fault DI5, gauge AI1)\n"
 "    A1 K2 TurboVacuumPump (at speed B1=DI2, fault DI6, gauge AI2, speed AI5)\n"
 "    A2 K3 UHVacuumPump_1 turbo (B2=DI3, fault DI7, gauge AI3, speed AI6)\n"
 "    A3 K4 UHVacuumPump_2 turbo (B3=DI4, fault DI8, gauge AI4, speed AI7)\n"
 "    A4 K5 HighVoltageTransformer permissive.  Wiring: WIRING.md")
items.append([Sym("text"), NOTES, [Sym("at"), MARGIN, g(PH - 95), 0], eff(just=["left", "top"]), [Sym("uuid"), Sym(U("notes"))]])
out += items
out.append([Sym("sheet_instances"), [Sym("path"), "/", [Sym("page"), "1"]]])
open(sys.argv[1], "w").write(dump(out) + "\n")
print("units", len(placements), "rows end", round(by + row_h))
