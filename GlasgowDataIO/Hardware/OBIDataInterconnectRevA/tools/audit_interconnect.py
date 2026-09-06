#!/usr/bin/env python3
"""Small source audit for the passive OBI data interconnect."""
from pathlib import Path
import re
import sys

PCB = Path(__file__).resolve().parents[1] / "board" / "OBI Data Interconnect.kicad_pcb"
text = PCB.read_text(encoding="utf-8")

errors = []
required_footprints = ["J1", "J2", "J3", "J4", "JP1", "JP2", "RN1", "RN2", "RN3"]
for ref in required_footprints:
    if not re.search(r'\(property "Reference" "' + re.escape(ref) + r'"', text):
        errors.append(f"missing footprint reference {ref}")

for n in range(1, 25):
    if text.count(f'"/D-{n}"') < 1:
        errors.append(f"missing net /D-{n}")

for net in ("External +3.3V Source", "Glasgow +3.3V Source", "+3.3V", "GNDD"):
    if f'"{net}"' not in text:
        errors.append(f"missing power/return net {net}")

def footprint_block(reference: str) -> str | None:
    marker = f'(property "Reference" "{reference}"'
    marker_at = text.find(marker)
    if marker_at < 0:
        return None
    start = text.rfind("\n\t(footprint ", 0, marker_at)
    if start < 0:
        return None
    depth = 0
    for pos in range(start + 1, len(text)):
        if text[pos] == "(":
            depth += 1
        elif text[pos] == ")":
            depth -= 1
            if depth == 0:
                return text[start:pos + 1]
    return None

# The three output headers must carry eight odd data pins each.
for ref, first, last in (("J3", 1, 8), ("J4", 9, 16), ("J2", 17, 24)):
    block = footprint_block(ref)
    if not block:
        errors.append(f"cannot locate footprint block {ref}")
        continue
    body = block
    for n in range(first, last + 1):
        if f'"/D-{n}"' not in body:
            errors.append(f"{ref} does not contain /D-{n}")

if errors:
    print("FAIL")
    print("\n".join(f"- {e}" for e in errors))
    sys.exit(1)
print("PASS: required connectors, power nets, and D-1..D-24 source nets are present")
