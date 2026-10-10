import csv, sys
from collections import OrderedDict
import design
rows = OrderedDict()
for c in design.C:
    if c["ref"].startswith("#") or c["ref"].startswith("H"): continue
    k = (c["value"], c["fp"].split(":")[1], c["mpn"])
    rows.setdefault(k, {"refs": [], "desc": c["desc"]})["refs"].append(c["ref"])
with open(sys.argv[1], "w", newline="") as f:
    w = csv.writer(f); w.writerow(["Qty", "References", "Value", "Footprint", "Manufacturer part / spec", "Notes"])
    for (v, fp, mpn), r in rows.items():
        w.writerow([len(r["refs"]), " ".join(sorted(r["refs"], key=lambda x: (x.rstrip("0123456789"), int(''.join(ch for ch in x if ch.isdigit()) or 0)))), v, fp, mpn, r["desc"]])
print(len(rows), "BOM lines")
