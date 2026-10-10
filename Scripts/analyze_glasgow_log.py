#!/usr/bin/env python3
"""Summarize ADC behaviour per scan from a (large) GlasgowService.log.

Streams the file line by line, so a 100+ MB log is fine. For each
"scan start ... scan end" block it reports:

  * the timing profile that was actually built (from "Scan acquisition:"),
  * the controller profile (upstream vs diagnostic-extended, when logged),
  * the bitstream id,
  * the ADC signature: distinct 16-bit words seen in "FIFO: read <...>" lines
    (the logger truncates long reads, so this is the *leading* words only) and
    the authoritative "ADC sample summary:" line when the service wrote one,
  * the isolated ADC-only pad diagnostic, when present.

It then prints a verdict per scan. The point is to separate "timing-sensitive"
failures (values change when timing changes) from "static" failures (identical
value whatever the timing), because those need completely different fixes.

Usage:
    python Scripts/analyze_glasgow_log.py ~/Downloads/GlasgowService.log
    python Scripts/analyze_glasgow_log.py LOG --csv out.csv
"""
import argparse
import collections
import csv
import re
import sys

RE_SCAN_START = re.compile(r"^(\d\d-\d\d \d\d:\d\d:?\d*) GlasgowService\s+INFO\s+scan start kind=(\w+) production=(\w+)")
RE_SCAN_END = re.compile(r"GlasgowService\s+INFO\s+scan end kind=(\w+) ok=(\w+) elapsed=([\d.]+)s")
RE_ACQ = re.compile(
    r"Scan acquisition: production=(\S+) adc_half_period=(\d+) adc_settle_cycles=(\d+) "
    r"adc_latch_cycles=(\d+) bus_turnaround_cycles=(\d+) dac_data_setup_cycles=(\d+) "
    r"dac_latch_cycles=(\d+)")
RE_PROFILE = re.compile(r"Scan controller: profile=(\S+)")
RE_BITSTREAM = re.compile(r"launcher: loaded bitstream (\w+)")
RE_READ = re.compile(r"FIFO: read <([0-9a-f]+)(?:\.\.\.|>)")
RE_SUMMARY = re.compile(r"ADC sample summary: samples=(\d+) min=(0x[0-9a-f]+) max=(0x[0-9a-f]+) unique=(\d+)")
RE_PAD = re.compile(r"ADC PAD diagnostic (\w+): raw_last=(0x[0-9a-f]+) seen_low=(0x[0-9a-f]+) seen_high=(0x[0-9a-f]+)")
RE_OWN = re.compile(r"Bus ownership observed: (.*)")
RE_PG = re.compile(r"power_good \((\w+)\): (K1 \w+|K1 not configured)")
SYNC_WORDS = {"ffff", "007b"}  # sync marker and default cookie; not ADC data


def blank_scan(idx, ts, kind, production):
    return dict(idx=idx, start=ts, kind=kind, production=production, acq=None, profile=None,
                bitstream=None, words=collections.Counter(), summary=None, pad=None,
                ownership=None, pg={}, ok=None, elapsed=None)


def verdict(scan):
    if scan["pad"] and int(scan["pad"]["seen_low"], 16) == 0 and int(scan["pad"]["seen_high"], 16) != 0:
        return "PADS NEVER LOW (bus undriven/stuck high, or ADC railed)"
    if scan["summary"] and scan["summary"]["unique"] == 1:
        return "CONSTANT ADC (%s over %d samples)" % (scan["summary"]["min"], scan["summary"]["samples"])
    data_words = [w for w in scan["words"] if w not in SYNC_WORDS]
    if len(data_words) == 1:
        return "CONSTANT (leading words all %s)" % data_words[0]
    if len(data_words) > 1:
        return "varying (%d distinct leading words)" % len(data_words)
    return "no ADC data seen"


def parse(path):
    scans, cur = [], None
    with open(path, errors="replace") as fh:
        for line in fh:
            # Cheap substring gates keep this fast on 2M-line logs.
            if "scan start" in line:
                m = RE_SCAN_START.match(line)
                if m:
                    cur = blank_scan(len(scans) + 1, m.group(1), m.group(2), m.group(3))
                    scans.append(cur)
                continue
            if cur is None:
                continue
            if "FIFO: read <" in line:
                m = RE_READ.search(line)
                if m:
                    h = m.group(1)
                    for j in range(0, len(h) - len(h) % 4, 4):
                        cur["words"][h[j:j + 4]] += 1
                continue
            if "Scan acquisition" in line:
                m = RE_ACQ.search(line)
                if m:
                    cur["acq"] = tuple(int(x) for x in m.groups()[1:])
            elif "Scan controller" in line:
                m = RE_PROFILE.search(line)
                if m:
                    cur["profile"] = m.group(1)
            elif "loaded bitstream" in line:
                m = RE_BITSTREAM.search(line)
                if m:
                    cur["bitstream"] = m.group(1)
            elif "ADC sample summary" in line:
                m = RE_SUMMARY.search(line)
                if m:
                    cur["summary"] = dict(samples=int(m.group(1)), min=m.group(2),
                                          max=m.group(3), unique=int(m.group(4)))
            elif "ADC PAD diagnostic" in line:
                m = RE_PAD.search(line)
                if m:
                    cur["pad"] = dict(when=m.group(1), raw_last=m.group(2),
                                      seen_low=m.group(3), seen_high=m.group(4))
            elif "power_good (" in line:
                m = RE_PG.search(line)
                if m:
                    cur["pg"][m.group(1)] = m.group(2)
            elif "Bus ownership observed" in line:
                m = RE_OWN.search(line)
                if m:
                    cur["ownership"] = m.group(1)
            elif "scan end" in line:
                m = RE_SCAN_END.search(line)
                if m:
                    cur["ok"], cur["elapsed"] = m.group(2), float(m.group(3))
    return scans


def fmt_acq(acq):
    if not acq:
        return "n/a"
    half, settle, latch, turn, dsetup, dlatch = acq
    return f"half={half} settle={settle} latch={latch} turn={turn} dac={dsetup}/{dlatch}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("log")
    ap.add_argument("--csv", help="also write the table to this CSV file")
    args = ap.parse_args()

    scans = parse(args.log)
    if not scans:
        print("no 'scan start' lines found", file=sys.stderr)
        return 1

    rows = []
    for s in scans:
        rows.append([s["idx"], s["start"], s["kind"], fmt_acq(s["acq"]),
                     s["profile"] or "(not logged)", (s["bitstream"] or "")[:8],
                     ",".join(w for w, _ in s["words"].most_common(3) if w not in SYNC_WORDS) or "-",
                     "/".join(f"{k}:{v.replace('K1 ', '')}" for k, v in s["pg"].items()) or "(not logged)",
                     verdict(s)])
    header = ["#", "start", "kind", "timing", "controller", "bitstream", "lead words", "power_good", "verdict"]
    widths = [max(len(str(r[i])) for r in rows + [header]) for i in range(len(header))]
    for r in [header] + rows:
        print("  ".join(str(c).ljust(w) for c, w in zip(r, widths)))

    # The sweep test: did the ADC value change when timing changed?
    timings = {s["acq"] for s in scans if s["acq"]}
    values = {tuple(sorted(w for w in s["words"] if w not in SYNC_WORDS)) for s in scans if s["words"]}
    print()
    print(f"distinct timing profiles: {len(timings)}; distinct leading-word signatures: {len(values)}")
    if len(timings) > 2 and len(values) <= 2:
        print("=> Readback did not follow timing changes. That points at a static cause "
              "(pad level / clock / power / analog), not a sampling-phase problem.")
    for s in scans:
        if s["ownership"]:
            print(f"scan {s['idx']}: bus ownership: {s['ownership']}")
            break

    if args.csv:
        with open(args.csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(header)
            w.writerows(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
