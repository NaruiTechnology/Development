"""Release gate and fabrication notes for the RPi5VacuumIO package (used by make_fab_kicad10.*).

    fabnotes.py gate  --erc erc.json --drc drc.json --summary summary.json
    fabnotes.py notes --board X.kicad_pcb --summary summary.json --stats stats.json \
                      --rev A.1 --date 2026-10-16 --kicad 10.0.7 --out fab/README.md
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sexp import find, find1, parse  # noqa: E402


def _count(items):
    sev = collections.Counter(v.get("severity", "error") for v in items)
    types = collections.Counter(f"{v.get('severity')}: {v.get('type')}" for v in items)
    return sev, types


def gate(args) -> int:
    erc = json.loads(Path(args.erc).read_text())
    drc = json.loads(Path(args.drc).read_text())
    erc_v = [v for s in erc.get("sheets", []) for v in s.get("violations", [])]
    erc_sev, erc_types = _count(erc_v)
    drc_sev, drc_types = _count(drc.get("violations", []))
    unconnected = len(drc.get("unconnected_items", []))
    parity = drc.get("schematic_parity", [])
    parity_err = [p for p in parity if p.get("severity", "error") == "error"]
    summary = {
        "erc": {"errors": erc_sev.get("error", 0), "warnings": erc_sev.get("warning", 0),
                "by_type": dict(erc_types)},
        "drc": {"errors": drc_sev.get("error", 0), "warnings": drc_sev.get("warning", 0),
                "unconnected": unconnected, "parity_errors": len(parity_err),
                "parity_warnings": len(parity) - len(parity_err), "by_type": dict(drc_types)},
        "kicad_version": drc.get("kicad_version"),
    }
    Path(args.summary).write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    failed = []
    if summary["erc"]["errors"]:
        failed.append(f"ERC: {summary['erc']['errors']} error(s)")
    if summary["drc"]["errors"]:
        failed.append(f"DRC: {summary['drc']['errors']} error(s)")
    if unconnected:
        failed.append(f"DRC: {unconnected} unconnected item(s)")
    if parity_err:
        failed.append(f"schematic parity: {len(parity_err)} issue(s)")
    if failed:
        print("RELEASE GATE FAILED: " + "; ".join(failed) + " (see fab/reports)", file=sys.stderr)
        return 1
    print("release gate: PASS")
    return 0


ADVISORY_RULES = ("silk_overlap", "text_height", "text_thickness", "silk_over_copper")


def advisory_project(args) -> int:
    """Turn the rules the project ignores into warnings (copy of the .kicad_pro only)."""
    p = Path(args.project)
    d = json.loads(p.read_text())
    sev = d["board"]["design_settings"].setdefault("rule_severities", {})
    for k in ADVISORY_RULES:
        sev[k] = "warning"
    p.write_text(json.dumps(d, indent=2))
    return 0


def advisory_counts(path) -> dict:
    try:
        d = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}
    return dict(collections.Counter(v["type"] for v in d.get("violations", [])
                                    if v.get("type") in ADVISORY_RULES))


def board_facts(path: Path) -> dict:
    b = parse(path.read_text())
    xs, ys = [], []
    for g in find(b, "gr_line") + find(b, "gr_rect") + find(b, "gr_arc"):
        if str(find1(g, "layer")[1]) == "Edge.Cuts":
            for k in ("start", "end", "mid"):
                e = find1(g, k)
                if e:
                    xs.append(float(e[1])); ys.append(float(e[2]))
    setup = find1(b, "setup")
    stack = find1(setup, "stackup")
    copper = [find1(l, "thickness") for l in find(stack, "layer") if find1(l, "type")[1] == "copper"]
    finish = find1(stack, "copper_finish")
    mask = [find1(l, "color") for l in find(stack, "layer") if "Mask" in find1(l, "type")[1]]
    silk = [find1(l, "color") for l in find(stack, "layer") if "Silk" in find1(l, "type")[1]]
    widths = [float(find1(t, "width")[1]) for t in find(b, "segment")]
    vias = [(float(find1(v, "size")[1]), float(find1(v, "drill")[1])) for v in find(b, "via")]
    fps = find(b, "footprint")
    smd = th = other = 0
    holes = collections.Counter()
    for fp in fps:
        a = find1(fp, "attr")
        kind = str(a[1]) if a else ""
        if kind == "smd":
            smd += 1
        elif kind == "through_hole":
            th += 1
        else:
            other += 1
        for pad in find(fp, "pad"):
            d = find1(pad, "drill")
            if d:
                vals = [float(x) for x in d[1:] if not isinstance(x, list) and str(x) != "oval"]
                if vals:
                    holes[(str(pad[2]), vals[0])] += 1
    for size, drill in vias:
        holes[("via", drill)] += 1
    rules = {}
    pro = path.with_suffix(".kicad_pro")
    if pro.exists():
        rules = json.loads(pro.read_text())["board"]["design_settings"]["rules"]
    tb = find1(b, "title_block")
    return {
        "w": max(xs) - min(xs), "h": max(ys) - min(ys),
        "thickness": float(find1(find1(b, "general"), "thickness")[1]),
        "copper_um": [round(float(c[1]) * 1000) for c in copper if c],
        "finish": finish[1] if finish else "unspecified",
        "mask": mask[0][1] if mask and mask[0] else "Green",
        "silk": silk[0][1] if silk and silk[0] else "White",
        "min_track": min(widths), "vias": collections.Counter(vias),
        "smd": smd, "th": th, "other": other, "holes": holes, "rules": rules,
        "title": dict((str(e[0]), e[-1]) for e in tb[1:]) if tb else {},
    }


def notes(args) -> int:
    f = board_facts(Path(args.board))
    s = json.loads(Path(args.summary).read_text())
    r = f["rules"]
    min_clear = r.get("min_clearance", "?")
    min_drill = min(d for (_, d) in f["holes"])
    via_txt = ", ".join(f"{n}× Ø{d:g}/{s_:g} mm" for (s_, d), n in sorted(f["vias"].items()))
    hole_rows = "\n".join(f"| {kind} | {d:g} | {n} |" for (kind, d), n in sorted(f["holes"].items()))
    N = "RPi5VacuumIO"
    rev = args.rev
    adv = advisory_counts(args.advisory) if args.advisory else {}
    adv_rows = "\n".join(f"| `{k}` | {v} |" for k, v in sorted(adv.items())) or "| none | 0 |"
    text = f"""# {N} rev {rev} — manufacturing package

{f['title'].get('title', N)} · {f['title'].get('company', '')} · released {args.date} ·
generated by KiCad {args.kicad} (`tools/make_fab_kicad10.sh` / `.ps1`) from the checked-in board.
**Do not edit these files by hand** — change the board and regenerate.

## Release checks

| Check | Result |
|---|---|
| ERC | {s['erc']['errors']} errors, {s['erc']['warnings']} warnings |
| DRC (zones refilled, all severities) | {s['drc']['errors']} errors, {s['drc']['warnings']} warnings |
| Unconnected items | {s['drc']['unconnected']} |
| Schematic ↔ board parity | {s['drc']['parity_errors']} errors, {s['drc']['parity_warnings']} warnings |

Reports: `reports/` (ERC/DRC as text and JSON, drill report, board statistics).

## Bare board — order with `{N}-gerbers-{rev}.zip`

| Parameter | Value |
|---|---|
| Size | {f['w']:.2f} × {f['h']:.2f} mm, single board (no panel); 4 × M3 NPTH Ø3.2 mm |
| Layers | 2 (F.Cu, B.Cu) |
| Material / thickness | FR-4, Tg ≥ 135 °C, {f['thickness']:g} mm ± 10 % |
| Copper | {' / '.join(str(c) for c in f['copper_um'])} µm finished (1 oz) both layers |
| Surface finish | {f['finish']} (lead-free) |
| Solder mask / silkscreen | {f['mask']}, both sides / {f['silk']}, both sides |
| Min. track / clearance | {f['min_track']:g} mm / {min_clear} mm (6 / 6 mil) |
| Min. finished hole | {min_drill:g} mm (vias); vias {via_txt}, tented both sides |
| Plated slots / castellations / edge plating | none |
| Impedance control | none |
| Quality | IPC-6012 Class 2; 100 % electrical test against `{N}-ipcd356.ipc` |
| Marking | board house may add date code / UL mark on B.Silkscreen, away from text |

Files in `gerbers/` (Gerber X2, coordinates from the drill/place origin):

| File | Layer |
|---|---|
| `{N}-F_Cu.gtl` / `{N}-B_Cu.gbl` | Copper top / bottom |
| `{N}-F_Mask.gts` / `{N}-B_Mask.gbs` | Solder mask top / bottom |
| `{N}-F_Silkscreen.gto` / `{N}-B_Silkscreen.gbo` | Silkscreen top / bottom (clipped at mask openings) |
| `{N}-F_Paste.gtp` / `{N}-B_Paste.gbp` | Paste top / bottom (stencil) |
| `{N}-Edge_Cuts.gm1` | Board outline |
| `{N}-PTH.drl` / `{N}-NPTH.drl` | Excellon, mm, plated / non-plated |
| `*-drl_map.gbr` | Drill maps |
| `{N}-job.gbrjob` | Gerber job file: stackup, finish, mask/silk colours |

Hole table (finished sizes):

| Type | Ø mm | Count |
|---|---|---|
{hole_rows}

## Assembly — `assembly/`

| | |
|---|---|
| Sides | top only: {f['smd']} SMD + {f['th']} through-hole footprints (+{f['other']} non-placed: solder jumpers JP1–JP9 and mounting holes) |
| BOM | `{N}-bom.csv` — grouped by value/footprint/MPN, DNP and solder jumpers excluded |
| Pick-and-place | `{N}-pos.csv` (SMD only, for the machine) and `{N}-pos-all.csv` (incl. THT), mm, drill/place origin, KiCad rotation convention |
| Drawing | `{N}-assembly-top.pdf` (fab layer + silkscreen) |
| Standard | IPC-A-610 Class 2, lead-free (RoHS) |
| Through-hole | relays K1–K10, Phoenix headers J1, J2, J4, J5, J11–J18, J21–J24, J31–J34, J41, J42, box header J3, fuse F1 (TR5): selective or wave solder after reflow |
| Solder jumpers | JP1–JP8 are bridged 1–2 in copper (relay coil rails: K1 E-stop rail, K2–K8 watchdog rail) and JP9 (RS-485 termination) is left open: **no solder on any jumper** |
| Not fitted by the assembler | mating plugs (Phoenix part numbers in the BOM notes), ribbon cable |

Passives specified by value/package/rating in the MPN column (for example `0805 100nF 50V X7R`, `SMD:R 10k 1%`)
may be any compliant part; named parts must not be substituted without approval.

## Other files

| File | Purpose |
|---|---|
| `{N}-ipc2581.xml` | IPC-2581 (complete build data, single file) |
| `{N}-odb.zip` | ODB++ |
| `{N}-ipcd356.ipc` | IPC-D-356 netlist for bare-board electrical test |
| `{N}-schematic.pdf` | Schematic |
| `{N}.step` | 3D model (enclosure fit) |
| `{N}-render-*.png` | Board renders, if OpenGL was available when generated |
| `*-drl_map.pdf` | Drill drawing |
| `SHA256SUMS` | Checksums of every file in this folder |

## Review items (do not block fabrication)

Advisory DRC with the rules this project ignores turned on (`reports/{N}-drc-advisory.json`):

| Rule | Count |
|---|---|
{adv_rows}

`text_height` items are silkscreen labels below the project's 0.8 mm minimum (mostly 0.6 mm
terminal pin labels); `silk_overlap` items are silkscreen texts touching each other. Both affect
legibility only. The board has no fiducials: an SMT line can use the panel rails the board house adds.
STEP and renders include component bodies only if KiCad's 3D model library is installed on the
machine that ran the script.

## Electrical notes for the board house / assembler

- 24 V DC SELV board. Relay contact traces (K1–K8, net class *Contact*) have 1.0 mm clearance:
  rated for SELV signals only, **not** for mains.
- Main fuse F1 is 4 A. The 24 V distribution is on 0.8 mm / 1 oz traces: about a 30 °C rise at the full 4 A,
  well below that at typical solenoid loads.
"""
    Path(args.out).write_text(text)
    print(f"wrote {args.out}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gate")
    g.add_argument("--erc", required=True)
    g.add_argument("--drc", required=True)
    g.add_argument("--summary", required=True)
    n = sub.add_parser("notes")
    for a in ("--board", "--summary", "--stats", "--rev", "--date", "--kicad", "--out"):
        n.add_argument(a, required=True)
    n.add_argument("--advisory", default=None)
    a = sub.add_parser("advisory-project")
    a.add_argument("project")
    args = ap.parse_args(argv)
    return {"gate": gate, "notes": notes, "advisory-project": advisory_project}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
