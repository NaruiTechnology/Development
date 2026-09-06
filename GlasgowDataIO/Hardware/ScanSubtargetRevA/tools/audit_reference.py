#!/usr/bin/env python3
"""Read capture evidence and reference connectivity; never modify source inputs.

JSON goes to stdout. FIFO log excerpts may be truncated: statistics cover only
visible complete big-endian words, not the unlogged remainder of USB transfers.
This is an evidence extractor, not an electrical rule checker.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def capture_summary(path):
    counts = Counter()
    reads = truncated = sync_records = odd_records = 0
    first_read = first_non_full_scale = None
    sync_lines = []
    with path.open(encoding="utf-8", errors="replace") as stream:
        for line_number, line in enumerate(stream, 1):
            match = re.search(r"FIFO: read <([0-9a-fA-F]+)([^>]*)>", line)
            if match is None:
                continue
            raw, suffix = match.groups()
            # The recorded synchronization reply is two words: FFFF, cookie.
            # Do not discard longer payloads merely because they start FFFF.
            if len(raw) == 8 and raw.lower().startswith("ffff") and not suffix:
                sync_records += 1
                sync_lines.append(line_number)
                continue
            reads += 1
            truncated += int("..." in suffix)
            odd_records += int(len(raw) % 4 != 0)
            first_read = first_read or line_number
            for offset in range(0, len(raw) - 3, 4):
                value = int(raw[offset:offset + 4], 16)
                counts[value] += 1
                if value != 0x3FFF and first_non_full_scale is None:
                    first_non_full_scale = line_number
    return {
        "path": str(path), "sha256": digest(path),
        "data_read_records": reads, "truncated_data_read_records": truncated,
        "sync_reply_records_excluded": sync_records,
        "sync_reply_lines": sync_lines,
        "records_with_incomplete_visible_word": odd_records,
        "first_data_read_line": first_read,
        "first_non_3fff_word_line": first_non_full_scale,
        "visible_complete_words": sum(counts.values()),
        "visible_unique_words": len(counts),
        "visible_3fff_words": counts[0x3FFF],
        "visible_min": min(counts) if counts else None,
        "visible_max": max(counts) if counts else None,
        "most_common_visible_words": [
            {"hex": f"0x{v:04X}", "count": n} for v, n in counts.most_common(12)
        ],
        "limitation": "Visible log words only; omitted transfer bytes are unknown. "
                      "Four-byte FFFF/cookie replies excluded by recorded format. "
                      "Log record boundaries assumed to align to 16-bit samples.",
    }


def sexpr(text):
    root = []
    stack = [root]
    for match in re.finditer(r'\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+', text):
        token = match.group()
        if token == "(":
            child = []
            stack[-1].append(child)
            stack.append(child)
        elif token == ")":
            if len(stack) == 1:
                raise ValueError("Unbalanced closing parenthesis")
            stack.pop()
        else:
            if token.startswith('"'):
                token = token[1:-1].replace('\\"', '"').replace('\\\\', '\\')
            stack[-1].append(token)
    if len(stack) != 1 or len(root) != 1:
        raise ValueError("Unbalanced reference file")
    return root[0]


def children(node, kind):
    return [item for item in node if isinstance(item, list) and item and item[0] == kind]


def first(node, kind, default=None):
    nodes = children(node, kind)
    return nodes[0] if nodes else default


def board_summary(path):
    tree = sexpr(path.read_text(encoding="utf-8"))
    selected = {}
    footprints = children(tree, "footprint")
    for footprint in footprints:
        props = {item[1]: item[2] for item in children(footprint, "property")}
        ref = props.get("Reference", "")
        if ref not in {"U6", "U9", "U10", "U15", "U16", "J1", "J2", "J3", "J4", "J8"}:
            continue
        pads = []
        for pad in children(footprint, "pad"):
            net = first(pad, "net", ["net", "0", ""])
            pads.append({"pad": pad[1], "net": net[-1],
                         "pin_function": first(pad, "pinfunction", ["", ""])[-1]})
        selected[ref] = {"value": props.get("Value"), "footprint": footprint[1], "pads": pads}
    return {
        "path": str(path), "sha256": digest(path),
        "footprints": len(footprints), "track_segments": len(children(tree, "segment")),
        "vias": len(children(tree, "via")), "zones": len(children(tree, "zone")),
        "selected_connectivity": selected,
        "limitation": "Pad net assignments only. Not an ERC, DRC, or continuity check; "
                      "does not establish as-built connections or component population.",
    }


def platform_pinmap(path):
    source = path.read_text(encoding="utf-8")
    match = re.search(r'Connector\("lvds",\s*0,\s*((?:"[^"]*"\s*)+)\)', source)
    if match is None:
        raise ValueError("Cannot locate rev-C connector declaration")
    balls = "".join(re.findall(r'"([^"]*)"', match.group(1))).split()
    if len(balls) != 44:
        raise ValueError(f"Expected 44 connector positions, found {len(balls)}")
    return {ball: pin for pin, ball in enumerate(balls, 1) if ball != "-"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-data", type=Path, required=True)
    parser.add_argument("--glasgow-data-io", type=Path, required=True)
    args = parser.parse_args()
    root = args.glasgow_data_io
    platform = root / "IobeamControl/glasgowLib/glasgow/hardware/platform/rev_c.py"
    pinmap = platform_pinmap(platform)
    config_path = root / "Json/streamData.json"
    config = json.loads(config_path.read_text())
    action = next(a["streamData"]["actionData"] for a in config["Actions"] if "streamData" in a)
    # Export only electrical fields. Do not export unrelated connection credentials.
    pin_config = action["pins"]
    controls = [{"signal": pin["name"], "fpga_ball": pin["pin"],
                 "connector_pin": pinmap[pin["pin"]],
                 "inverted_at_pad": pin.get("invert", False)}
                for pin in pin_config["control"]["subsignals"]]
    data = [{"bit": bit, "fpga_ball": ball, "connector_pin": pinmap[ball]}
            for bit, ball in enumerate(pin_config["data"]["pins"].split())]
    report = {
        "status": "reference audit, not a manufacturing release",
        "captures": [capture_summary(args.raw_data / folder / "GlasgowService.log")
                     for folder in ("生产模式_矢量", "仿真模式_矢量", "X_and_Y_矢量")],
        "reference_boards": [board_summary(path) for path in
                             sorted((args.raw_data / "硬件文档").glob("*.kicad_pcb"))],
        "current_interface": {
            "config_path": str(config_path), "platform_sha256": digest(platform),
            "controls": controls, "data_lsb_first": data,
            "adc_half_period_cycles": action.get("adcHalfPeriod"),
            "adc_settle_cycles": action.get("adcSettleCycles"),
            "nominal_rev_c_sync_hz": 48_000_000,
            "nominal_adc_hz": 48_000_000 / (2 * action["adcHalfPeriod"]),
            "limitation": "Current checked-out configuration, not proven capture-time firmware.",
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
