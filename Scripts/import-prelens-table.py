#!/usr/bin/env python3
"""Import the legacy source workbook into processingPatterns.json (requires xlrd only for import)."""
import argparse
import hashlib
import json
from pathlib import Path


def import_table(source):
    import xlrd
    book = xlrd.open_workbook(str(source))
    sheet = book.sheet_by_name("Sheet1")
    expected = ["Steps Between Apertures", "KV", "ID      (um)", "pA", "Lens 1   (kV)", "Spot Size   (Angstroms)"]
    if sheet.row_values(0)[:6] != expected:
        raise ValueError("Unexpected lens workbook headers")
    keys = ["stepsBetweenApertures", "beamVoltageKV", "apertureDiameterUM", "beamCurrentPA", "lens1KV", "spotSizeAngstrom"]
    rows, notes = [], []
    for index in range(1, sheet.nrows):
        cells = sheet.row_values(index)[:6]
        if isinstance(cells[1], (int, float)):
            row = {"sourceRow": index + 1}
            for key, value in zip(keys, cells):
                row[key] = None if value == "" else int(value) if isinstance(value, float) and value.is_integer() else value
            rows.append(row)
        elif isinstance(cells[0], str) and cells[0].strip():
            notes.append({"sourceRow": index + 1, "text": cells[0]})
    if len(rows) != 11:
        raise ValueError(f"Expected 11 lens records, found {len(rows)}")
    return {"schemaVersion": 1, "name": "LENS 1 PRELENS",
            "source": {"file": source.name, "sheet": sheet.name, "range": "A1:F22", "sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
            "sourceHeaders": expected, "rows": rows, "notes": notes,
            "interpolation": "Exact match by voltage and current by default. Optional linear interpolation of spot size between numeric current anchors at the same voltage. No extrapolation; bounded current rows are reference only. Lens 1 settings are never interpolated."}


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, default=root / "GlasgowDataIO/Calibration/LENS 1 PRELENS.xls")
    parser.add_argument("--catalogue", type=Path, default=root / "GlasgowDataIO/Json/processingPatterns.json")
    args = parser.parse_args()
    table = import_table(args.source)
    text = args.catalogue.read_text()
    document = json.loads(text)
    if "LensLookup" in document:
        # Replace exactly the lookup object, preserving the rest of the operator's catalogue.
        start = text.index('"LensLookup":') + len('"LensLookup":')
        start += len(text[start:]) - len(text[start:].lstrip())
        _, length = json.JSONDecoder().raw_decode(text[start:])
        text = text[:start] + json.dumps(table, ensure_ascii=False, indent=4).replace("\n", "\n    ") + text[start+length:]
    else:
        marker = '    "Patterns": ['
        value = json.dumps(table, ensure_ascii=False, indent=4).replace("\n", "\n    ")
        text = text.replace(marker, '    "LensLookup": ' + value + ',\n' + marker, 1)
    args.catalogue.write_text(text)
    print(f"Imported {len(table['rows'])} rows and {len(table['notes'])} notes into {args.catalogue}")


if __name__ == "__main__":
    main()
