"""One-time schematic -> board sync for the KiCad 10 release (what "Update PCB from Schematic"
would do), plus two schematic corrections found by KiCad 10 ERC/DRC.

    kicad-cli sch export netlist -o /tmp/n.net RPi5VacuumIO.kicad_sch
    python3 tools/sync_from_schematic.py --netlist /tmp/n.net

Schematic (RPi5VacuumIO.kicad_sch):
  * ADS1115 ALERT/RDY (pin 2) is open-drain per the TI datasheet; the library symbol typed it
    as a push-pull output, so wiring U9 and U10 ALERT/RDY together (intended wired-AND with R13)
    raised an ERC pin-to-pin error.  Pin type -> open_collector.
  * Solder jumpers JP1-JP9 are copper features, not purchased parts: in_bom no (the footprints
    were already excluded from BOM and placement).

Board (RPi5VacuumIO.kicad_pcb / .kicad_pro):
  * net names follow the schematic netlist (root-sheet labels are "/NAME"); netclass patterns
    are rewritten to match, and the script verifies every net keeps its net class;
  * MPN and Description fields copied from the schematic symbols onto the footprints, so
    IPC-2581 / ODB++ carry the part numbers.

Idempotent: re-running changes nothing.  Copper geometry is not touched.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sexp import find, find1, parse  # noqa: E402

N = "RPi5VacuumIO"


def fix_schematic(text: str) -> tuple[str, list[str]]:
    notes = []
    pin = re.compile(r'\(pin output line(\s*\(at [^)]*\)\s*\(length [^)]*\)\s*\(name "ALERT/RDY")')
    text, n = pin.subn(r'(pin open_collector line\1', text)
    if n:
        notes.append(f"ADS1115 ALERT/RDY pin type -> open_collector ({n} pin definition)")
    jp = re.compile(r'(\(lib_id "Jumper:SolderJumper_[^"]*"\)(?:\s*\((?:at|unit) [^)]*\))*\s*)\(in_bom yes\)')
    text, n = jp.subn(r'\1(in_bom no)', text)
    if n:
        notes.append(f"solder jumpers excluded from BOM ({n} symbols)")
    return text, notes


def netlist_info(path: Path):
    net = parse(path.read_text())
    nets = find(find1(net, "nets"), "net")
    names = [find1(n, "name")[1] for n in nets]
    unconnected = {}
    for n in nets:
        name = find1(n, "name")[1]
        if name.startswith("unconnected-("):
            for node in find(n, "node"):
                unconnected[(find1(node, "ref")[1], find1(node, "pin")[1])] = name
    fields = {}
    for comp in find(find1(net, "components"), "comp"):
        ref = find1(comp, "ref")[1]
        f = {}
        fl = find1(comp, "fields")
        for fld in find(fl, "field") if fl else []:
            name = [e for e in fld if isinstance(e, list) and e[0] == "name"][0][1]
            f[name] = fld[-1] if isinstance(fld[-1], str) else ""
        desc = find1(comp, "description")
        if "Description" not in f and desc:
            f["Description"] = desc[1]
        fields[ref] = f
    return names, fields, unconnected


def fix_board(text: str, sch_nets: list[str], fields: dict,
              unconnected: dict | None = None) -> tuple[str, dict, list[str]]:
    unconnected = unconnected or {}
    pads_named = 0
    notes = []
    board_nets = set(re.findall(r'\(net "([^"]*)"\)', text))
    rename = {b: "/" + b for b in board_nets if ("/" + b) in sch_nets and b not in sch_nets}
    if rename:
        text = re.sub(r'\(net "([^"]*)"\)',
                      lambda m: f'(net "{rename.get(m.group(1), m.group(1))}")', text)
        notes.append(f"{len(rename)} nets renamed to the schematic names (/NAME)")

    # MPN / Description on footprints
    added = 0
    out, pos = [], 0
    for m in re.finditer(r'\n\t\(footprint "', text):
        start = m.start() + 1
        if start < pos:
            continue
        end = _span(text, start)
        block = text[start:end]
        ref = re.search(r'\(property "Reference" "([^"]*)"', block).group(1)
        want = fields.get(ref, {})
        new_block = block
        for key in ("MPN", "Description"):
            value = want.get(key)
            if value is None:
                continue
            esc = value.replace("\\", "\\\\").replace('"', '\\"')
            prop = re.search(rf'\(property "{key}" "((?:[^"\\]|\\.)*)"', new_block)
            if prop:
                if prop.group(1) != esc:
                    new_block = new_block[:prop.start(1)] + esc + new_block[prop.end(1):]
                    added += 1
            else:
                anchor = new_block.index("\t\t(path ")
                new_block = new_block[:anchor] + _prop(key, esc) + new_block[anchor:]
                added += 1
        def name_pad(m, ref=ref):
            nonlocal pads_named
            pad = m.group(0)
            key = (ref, m.group(1))
            if key in unconnected and "(net " not in pad:
                pads_named += 1
                return pad.replace("\t\t\t(uuid ", f'\t\t\t(net "{unconnected[key]}")\n\t\t\t(uuid ', 1)
            return pad
        new_block = re.sub(r'\t\t\(pad "([^"]*)"[^\n]*\n(?:\t\t\t[^\n]*\n)*?\t\t\)', name_pad, new_block)
        out.append(text[pos:start]); out.append(new_block); pos = end
    out.append(text[pos:])
    text = "".join(out)
    if pads_named:
        notes.append(f"{pads_named} unused pads given their schematic 'unconnected-' nets")
    if added:
        notes.append(f"{added} footprint MPN/Description fields set from the schematic")
    return text, rename, notes


def _prop(key: str, value: str) -> str:
    return (f'\t\t(property "{key}" "{value}"\n\t\t\t(at 0 0 0)\n\t\t\t(layer "F.Fab")\n\t\t\t(hide yes)\n'
            f'\t\t\t(uuid "{uuid.uuid4()}")\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n'
            '\t\t\t\t)\n\t\t\t)\n\t\t)\n')


def _span(text: str, start: int) -> int:
    depth, i, in_str = 0, start, False
    while True:
        c = text[i]
        if in_str:
            if c == "\\":
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1


def netclass_of(name: str, patterns: list[dict]) -> str:
    for p in patterns:
        if fnmatch.fnmatchcase(name, p["pattern"]):
            return p["netclass"]
    return "Default"


def fix_project(pro: dict, rename: dict, all_nets: set[str]) -> list[str]:
    ns = pro["net_settings"]
    old = ns.get("netclass_patterns") or []
    if not rename:
        return []
    new = [dict(p, pattern=p["pattern"] if p["pattern"].startswith("/") else "/" + p["pattern"]) for p in old]
    inverse = {v: k for k, v in rename.items()}
    for net in all_nets:
        before = netclass_of(inverse.get(net, net), old)
        after = netclass_of(net, new)
        if before != after:
            raise SystemExit(f"net class of {net} would change: {before} -> {after}")
    ns["netclass_patterns"] = new
    return [f"{len(new)} netclass patterns re-anchored to /NAME (every net keeps its class)"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--netlist", type=Path, required=True)
    ap.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1])
    args = ap.parse_args(argv)
    sch_p, pcb_p, pro_p = (args.project / f"{N}.{e}" for e in ("kicad_sch", "kicad_pcb", "kicad_pro"))
    notes = []
    sch, n = fix_schematic(sch_p.read_text()); notes += n
    names, fields, unconnected = netlist_info(args.netlist)
    pcb, rename, n = fix_board(pcb_p.read_text(), names, fields, unconnected); notes += n
    pro = json.loads(pro_p.read_text())
    notes += fix_project(pro, rename, set(re.findall(r'\(net "([^"]*)"\)', pcb)))
    sch_p.write_text(sch); pcb_p.write_text(pcb)
    pro_p.write_text(json.dumps(pro, indent=2) + "\n")
    print("\n".join(notes) or "already in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())
