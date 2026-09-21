"""Build the normalized calibration catalog from the three vendor sources.

Output structure (JSON-serialisable):
  { groups, tables, definitions[], excluded[], stats }
Every definition carries `assign_basis` / `assign_conf` so that inferred FIB-vs-SEM ownership is
reviewable in the UI rather than hidden in code.
"""
from __future__ import annotations
import re, collections
from . import taxonomy as T
from .md_parser import MdRow
from .registry_parser import RegLeaf, infer_type

PREFIXES = ("IONF_", "IONI_", "IMD_", "MD_")
WORDS = {"SUP": "Suppressor", "SUPP": "Suppressor", "EXT": "Extractor", "HT": "High tension", "IFIL": "Filament current",
         "EMIS": "Emission", "WOB": "Wobble", "MAG": "Magnification", "ROT": "Rotation", "WD": "Working distance",
         "APER": "Aperture", "AP": "Aperture", "STIG": "Stigmator", "BSHIFT": "Beam shift", "DEFL": "Deflection",
         "CAL": "calibration", "FACT": "factor", "SENS": "sensitivity", "MIN": "min", "MAX": "max", "DEF": "default",
         "REF": "reference", "SEC": "seconds", "HRS": "hours", "UAMP": "uA", "PICO": "pico", "AMP": "amp",
         "BAL": "balance", "SPOTSIZE": "spot size", "SPY": "spy", "GIS": "GIS", "DSPG": "DSPG", "AVA": "AVA",
         "HEAT": "heat", "VISL": "VISL", "AS": "Autostart", "IGSU": "IGSU", "MATR": "Matrox", "DLY": "delay",
         "XP": "XP", "DBAR": "databar", "SDB": "SDB", "KEY": "key", "OPT": "option", "LENS": "lens", "GUN": "gun",
         "COL": "column", "COND": "condenser", "FIN": "final", "DAC": "DAC", "CONT": "contrast", "BRIGHT": "brightness",
         "CORR": "correction", "COEF": "coefficient", "VAC": "vacuum", "TILT": "tilt", "SHIFT": "shift", "CF1": "cf1"}


def humanize_symbol(sym: str) -> str:
    s = sym
    for p in PREFIXES:
        if s.startswith(p):
            s = s[len(p):]
            break
    toks = [t for t in s.split("_") if t]
    out = [WORDS.get(t, t if not t.isalpha() or len(t) <= 2 else t.capitalize()) for t in toks]
    txt = " ".join(out)
    return txt[:1].upper() + txt[1:] if txt else sym


def humanize_camel(s: str) -> str:
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s.replace("_", " "))
    return s[:1].upper() + s[1:]


def slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")


def fmt_num(x: float) -> float:
    return int(x) if float(x).is_integer() and abs(x) < 1e15 else x


# ============================================================== MD rules ==============================
def _in(slot, *ranges):
    return any(a <= slot <= b for a, b in ranges)


def fib_int_rule(r: MdRow):
    s = r.slot
    if _in(s, (0, 2), (8, 10)):  return "FIB.SYS.IDENT", "identity"
    if _in(s, (3, 7), (11, 20), (25, 25)): return "FIB.SYS.HW", "config"
    if _in(s, (31, 36)):         return "FIB.GIS.CFG", "config"
    if _in(s, (40, 43)):         return "FIB.SRC.SPY", "tuning"
    return "FIB.SYS.HW", "config"


def fib_float_rule(r: MdRow):
    s = r.slot
    table = [((0, 4), "FIB.SRC.SUPPR"), ((5, 9), "FIB.SRC.EXTR"), ((10, 15), "FIB.SRC.HT"),
             ((16, 24), "FIB.SRC.FIL"), ((25, 25), "FIB.SRC.LIFE"), ((26, 30), "FIB.SRC.FIL"),
             ((31, 35), "FIB.SRC.START"), ((36, 39), "FIB.SRC.EMIS"), ((40, 49), "FIB.OPT.LENS"),
             ((50, 51), "FIB.OPT.ALIGN"), ((52, 55), "FIB.APT.LIMITS"), ((56, 63), "FIB.OPT.MAG"),
             ((64, 65), "FIB.VAC"), ((66, 69), "FIB.PAT"), ((70, 82), "FIB.OPT.ALIGN"), ((83, 83), "FIB.SRC.EMIS"),
             ((84, 86), "FIB.OPT.MAG"), ((87, 87), "FIB.SRC.EMIS"), ((88, 90), "FIB.OPT.TILT"),
             ((91, 96), "FIB.GIS.LIFE"), ((97, 99), "FIB.IMG.SIZE"), ((101, 106), "FIB.SRC.SUPPR"),
             ((110, 115), "FIB.IMG.BIAS"), ((120, 127), "FIB.OPT.DEFL"), ((128, 129), "FIB.PAT"),
             ((130, 139), "FIB.IMG.DELAY"), ((140, 141), "FIB.OPT.MAG"), ((201, 434), "FIB.APT.PRESETS"),
             ((435, 439), "FIB.SRC.START"), ((440, 448), "FIB.SRC.TRACK")]
    for (a, b), g in table:
        if a <= s <= b:
            cls = {"FIB.SRC.LIFE": "counter", "FIB.GIS.LIFE": "counter", "FIB.APT.PRESETS": "preset"}.get(g, "calibration")
            return g, cls
    return "FIB.SYS.HW", "config"


def sem_int_rule(r: MdRow):
    s = r.slot
    if s == 0 or _in(s, (50, 58)):                 return "SEM.SYS.IDENT", "identity"
    if _in(s, (10, 41)):                           return "SEM.SYS.JUMPER", "config"
    if _in(s, (70, 93)):                           return "SEM.SYS.LICENSE", "config"
    if _in(s, (96, 115)):                          return "SEM.COL.GUNBIAS", "calibration"
    if _in(s, (116, 118)):                         return "SEM.DET.CB", "calibration"
    if _in(s, (119, 125)):                         return "SEM.COL.SCAN", "calibration"
    if s in (128, 129, 130, 131, 136) or _in(s, (154, 158)): return "SEM.SYS.PUMP", "config"
    if _in(s, (144, 152)):                         return "SEM.DISP", "config"
    if _in(s, (134, 135, ), (137, 140)):           return "SEM.STG.POS", "config"
    return "SEM.SYS.HW", "config"


def sem_float_rule(r: MdRow):
    """Named SEM floats. (Unnamed ones are routed to SEM.UND.* by the caller.)"""
    s = r.slot
    rules = [((0, 5), "SEM.COL.CORR", "calibration"), ((7, 8), "SEM.DISP", "config"),
             ((10, 49), "SEM.COL.COEF", "calibration"), ((50, 69), "SEM.COL.DAC", "limit"),
             ((70, 102), "SEM.COL.RANGE", "limit"), ((103, 107), "SEM.STG.POS", "calibration"),
             ((150, 159), "SEM.DET.GRID", "limit"), ((160, 166), "SEM.DISP", "config"),
             ((167, 196), "SEM.DET.CB", "calibration"), ((200, 208), "SEM.COL.COEF", "calibration"),
             ((350, 386), "SEM.COL.GUNSHIFT", "calibration"), ((668, 680), "SEM.STG.POS", "calibration"),
             ((921, 924), "SEM.DET.CB", "calibration"), ((955, 955), "SEM.STG.EUC", "calibration"),
             ((987, 988), "SEM.COL.RANGE", "limit"), ((995, 999), "SEM.COL.COEF", "calibration")]
    for (a, b), g, c in rules:
        if a <= s <= b:
            return g, c
    return "SEM.COL.COEF", "calibration"


def und_group(slot: int) -> str:
    return ("SEM.UND.0060" if slot < 200 else "SEM.UND.0204" if slot < 700 else
            "SEM.UND.0932" if slot < 1150 else "SEM.UND.1160")


SHARED_GROUP_PREFIXES = ("SEM.STG", "SEM.CTRL", "SEM.SYS.PUMP", "SEM.MODE", "SEM.DISP")


def access_for(flags: list[str], cls: str) -> str:
    if "F" in flags:                        return "fixed"
    if "ACB" in flags or cls == "counter":  return "auto"
    if "A--" in flags or cls in ("config", "identity", "undocumented"): return "service"
    return "adjustable"


def applicability_for(flags: list[str]) -> list[str]:
    out = []
    if "CS" in flags:  out.append("cascade_ui")
    if "DB" in flags:  out.append("db_flag")      # header says 'Coreco UI', inline text says 'DualBeam' -> ambiguous
    if "611" in flags: out.append("fib611_only")
    return out


def unit_for(sym: str | None, vendor_unit: str | None):
    if vendor_unit:
        return T.VENDOR_UNIT_NORMALISE.get(vendor_unit, vendor_unit), "vendor"
    if sym:
        for rx, u, src in T.UNIT_RULES:
            if re.search(rx, sym):
                return u, src
    return None, None


def build_md_definitions(rows: list[MdRow], et: str, excluded: list) -> list[dict]:
    defs: list[dict] = []
    by_kind_slot = {(r.kind, r.slot): r for r in rows}
    for r in rows:
        # ---- exclusions: credentials ------------------------------------------------------------
        if r.symbol and "PSWD" in r.symbol:
            excluded.append(dict(source=r.file, id=f"{r.kind} {r.slot}", name=r.symbol,
                                 reason="credential (packed ASCII password) - never stored"))
            continue
        named = r.symbol is not None
        table = row_key = col_key = None
        code = r.symbol
        note_semantics = named
        # ---- routing ---------------------------------------------------------------------------
        if et == "FIB":
            if r.kind == "int":
                group, cls = fib_int_rule(r)
            else:
                group, cls = fib_float_rule(r)
            basis, conf = "vendor_file", "high"
            if group == "FIB.APT.PRESETS":
                n, k = divmod(r.slot - 201, 18)
                col_key = r.symbol[len("IONF_AP_"):]
                assert T.AP_COLS[k]["key"] == col_key, (r.slot, col_key)
                table, row_key = "FIB_APERTURES", str(n + 1)
                code = f"IONF_AP{n + 1:02d}_{col_key}"
        else:  # SEM
            if r.kind == "int":
                group, cls = sem_int_rule(r)
            elif not named:
                group, cls = und_group(r.slot), "undocumented"
            else:
                group, cls = sem_float_rule(r)
            basis, conf = "vendor_file", "high"
            if r.kind == "float" and r.axis is not None:
                suffix = r.symbol[len("MD_8I_"):]
                if 681 <= r.slot <= 860:
                    i = (r.slot - 681) // 30
                    table, row_key, col_key, group = "SEM_STAGE_SERVO", T.AXES6[i], suffix, "SEM.STG.SERVO"
                else:
                    i = (r.slot - 871) // 10
                    table, row_key, col_key, group = "SEM_STAGE_SERVO2", T.AXES5[i], suffix, "SEM.STG.SERVO2"
                assert r.axis == row_key, (r.slot, r.axis, row_key)
                cls, code = "calibration", f"MD_8I_{row_key}_{suffix}"
            elif r.kind == "float" and 861 <= r.slot <= 870:
                i = (r.slot - 861) % 5
                col = "BACKLASH" if r.slot <= 865 else "HYSTERESIS"
                table, row_key, col_key, group, cls = "SEM_STAGE_BACKLASH", T.AXES5[i], col, "SEM.STG.BACKLASH", "calibration"
            if r.kind == "int" and 96 <= r.slot <= 115 and not named:
                code, note_semantics = f"IMD_L6_GUN_BIAS_{r.slot - 96:02d}", False
        if not named and code is None:
            code = f"{'IONF' if et == 'FIB' else 'MD'}_{r.kind[0].upper()}{r.slot:04d}"
        if named and re.search(r"not used|out of use|obsolete", r.description, re.I):
            cls = "unused"
        if not named and re.search(r"not used|out of use|obsolete", r.description, re.I):
            cls = "unused"
        # ---- typing ------------------------------------------------------------------------------
        val = r.value
        dtype = "int" if r.kind == "int" else "float"
        widget = None
        if et == "SEM" and r.kind == "int" and any(a <= r.slot <= b for a, b in T.TOGGLE_INT_RANGES_SEM):
            if val in (0, 1):
                dtype, widget = "bool", "toggle"
        enum = T.ENUMS.get(r.symbol) if r.kind == "int" else None
        if enum and widget is None:
            widget = "select"
        if widget is None:
            widget = "readonly" if cls in ("counter", "identity") else "raw" if cls == "undocumented" else "number"
        unit, unit_src = unit_for(r.symbol, r.unit)
        access = access_for(r.flags, cls)
        shared = any(group.startswith(p) for p in SHARED_GROUP_PREFIXES) if et == "SEM" else False
        defs.append(dict(
            et=et, group=group, code=code, vendor_name=r.symbol,
            display_name=(humanize_symbol(r.symbol) if named else f"Unnamed {r.kind} slot {r.slot}"),
            description=r.description or None, param_class=cls, data_type=dtype, unit=unit, unit_source=unit_src,
            access_level=access, applicability=applicability_for(r.flags), shared_hardware=shared,
            adjustment_no=r.adjustment_no, table=table, row_key=row_key, col_key=col_key,
            source_file=r.file, source_kind=r.kind, source_slot=r.slot, source_path=None, source_line=r.line,
            vendor_flags=" ".join(r.flags) or None, vendor_comment=r.comment or None,
            semantics_known=bool(note_semantics), assign_basis=basis, assign_conf=conf,
            enum=({str(k): v for k, v in enum.items()} if enum else None), ui_widget=widget,
            value_num=fmt_num(val), value_text=None, factory_num=None, factory_text=None,
            limit_min_code=None, limit_max_code=None, limit_source=None,
        ))
    # ---- backlash/hysteresis symbol codes (MD_BACKLASH_X ...) keep vendor spelling ------------------
    for d in defs:
        if d["table"] == "SEM_STAGE_BACKLASH":
            d["code"] = d["vendor_name"]
    return defs


# ====================================================================== limit derivation =============
_EXTRA_LIMITS = {   # value symbol -> (min symbol, max symbol)
    "IONF_SUP_USED": ("IONF_SUP_MIN", "IONF_SUP_MAX"), "IONF_EXT_CAL": ("IONF_EXT_MIN", "IONF_EXT_MAX"),
    "IONF_IFIL_CAL": ("IONF_IFIL_MIN", "IONF_IFIL_MAX"), "IONF_HT_MAX": ("IONF_HT_MIN", "IONF_HT_MAX_REF"),
    "MD_WORKDIST_EUC": ("MD_WORKDIST_MIN", "MD_WORKDIST_MAX"),
}
_NOT_A_RANGE = {"IONF_APER"}     # IONF_APER_DEF is a preset *number*, not a current within [MIN,MAX]


def derive_limits(defs: list[dict]) -> int:
    n = 0
    for et in ("FIB", "SEM"):
        by = {d["vendor_name"]: d for d in defs if d["et"] == et and d["vendor_name"] and not d["table"]}
        for sym in list(by):
            m = re.fullmatch(r"(.*)_MIN", sym)
            if not m or m.group(1) in _NOT_A_RANGE:
                continue
            b = m.group(1)
            if f"{b}_MAX" in by:
                for tgt in (f"{b}_DEF",):
                    if tgt in by:
                        by[tgt].update(limit_min_code=by[sym]["code"], limit_max_code=by[f"{b}_MAX"]["code"],
                                       limit_source="name_convention")
                        n += 1
        for tgt, (lo, hi) in _EXTRA_LIMITS.items():
            if tgt in by and lo in by and hi in by:
                by[tgt].update(limit_min_code=by[lo]["code"], limit_max_code=by[hi]["code"], limit_source="name_convention")
                n += 1
    return n


# ================================================================ registry ==========================
def R(et, group, cls="tuning", shared=False, conf="medium", basis="registry_path"):
    return dict(et=et, group=group, cls=cls, shared=shared, conf=conf, basis=basis)


SKIP_RULES = [
    (r"^UI1280\\usr\\", "user accounts / credentials / obfuscated keys (PII) - never stored"),
    (r"(^|\\)Traces(\\|$)", "debug trace flags"),
    (r"^ASPIServer", "SCSI debug flag"), (r"^ImageEngine", "image-engine debug / legacy file setting"),
    (r"^BehaviorServer\\(FEIGEM|JoyStick)", "logging / debug flags"),
    (r"^UI1280\\APP\\Convolutions", "image-filter kernels (user preference)"),
    (r"^UI1280\\APP\\Preferences\\(Colors|Databar)", "display preference"),
    (r"^UI1280\\APP\\Preferences$", "display preference"),
    (r"^UI1280\\APP\\(StageProgressDlgPos|ServiceTool|UI1280Test|Graph Display|Help|Images|EXE|StageFiles|"
     r"CNeutFiles|AcctLog|Network CAD|ErrorHandling|Mouse|Pattern)", "UI layout / file location / accounting / preference"),
]


def map_registry(path: str, name: str):
    p = path
    if p == "BehaviorServer":
        return R("SEM", "SEM.COL.COEF", "calibration", True, "low") if name == "WorkingDistanceFactor" else R("SEM", "SEM.SYS.HW", "config", True)
    if p == "BehaviorServer\\16bitsFEITAD":
        return R("FIB", "FIB.OPT.SPOTDAC", "calibration") if "IonBeam" in name else R("SEM", "SEM.COL.SPOTDAC", "calibration")
    if p == "BehaviorServer\\Monitor":  return R("SEM", "SEM.DISP", "config", True)
    if p == "BehaviorServer\\StartUp":  return R("SEM", "SEM.SYS.HW", "config", True)
    if p == "ib32":                     return R("FIB", "FIB.SYS.IDENT", "config", conf="high")
    if p == "ib32\\IonSource":          return R("FIB", "FIB.SRC.TRACK", "config", conf="high")
    if p == "server32":                 return R("SEM", "SEM.SYS.IDENT", "config", conf="high")
    if p.startswith("server32\\Neutralizer"):
        cls = "counter" if "FilamentVoltageUsage" in p or name in ("CycleCount", "FilamentLifeTime") else \
              "config" if name in ("Enabled", "CommPort", "CommInits", "RequiredMionVersion") else "calibration"
        return R("SEM", "SEM.NEUT", cls, conf="low")      # hardware sits under server32 (electron server); purpose assumed
    if p == "Stage":                    return R("FIB", "FIB.GIS.CFG", "config", True, "low")
    if p.startswith(("Stage\\AutoEuc", "Stage\\TargetAxisRawTol", "Stage\\Z_FWD")): return R("SEM", "SEM.STG.EUC", "tuning", True)
    if p.startswith("Stage\\sampleholder"): return R("SEM", "SEM.STG.HOLDER", "config", True)
    if p == "UI1280\\APP":              return R("SEM", "SEM.SYS.IDENT", "identity", True)
    if p.startswith("UI1280\\APP\\AutoFocus"): return R("SEM", "SEM.AUTO.FOCUS", "tuning", conf="high")
    if p.startswith("UI1280\\APP\\AutoStig"):  return R("SEM", "SEM.AUTO.STIG", "tuning", conf="high")
    if p == "UI1280\\APP\\BeamBlankStageMove": return R("SEM", "SEM.STG.MOVE", "tuning", True)
    if p == "UI1280\\APP\\CapProbe":    return R("SEM", "SEM.SYS.HW", "config", True)
    if p.endswith("Detectors\\ACB\\EBEAM"): return R("SEM", "SEM.DET.ACB", "tuning", conf="high")
    if p.endswith("Detectors\\ACB\\IonBEAM"): return R("FIB", "FIB.IMG.ACB", "tuning", conf="high")
    if re.search(r"Detectors\\(CDM|SED|CEM)\\", p):
        if "Ion" in name:      return R("FIB", "FIB.IMG.DET", "calibration", conf="medium", basis="name_rule")
        if "Electron" in name: return R("SEM", "SEM.DET.CDM", "calibration", conf="medium", basis="name_rule")
        return R("SEM", "SEM.DET.CDM", "config", True, "low", "default")
    if "Detectors\\XAIB2" in p:         return R("SEM", "SEM.CTRL", "config", True)
    if p == "UI1280\\APP\\DriftControl": return R("SEM", "SEM.AUTO.DRIFT", "tuning", conf="high")
    if p == "UI1280\\APP\\EPD":         return R("FIB", "FIB.PAT", "config", conf="medium")
    if p.startswith("UI1280\\APP\\FRCS"):
        cls = "config" if name in ("Enabled", "CommPort", "CommInits") else "calibration"
        return R("SEM", "SEM.CTRL", cls, True)
    if p == "UI1280\\APP\\LaserStage":  return R("SEM", "SEM.STG.LASER", "tuning", True)
    if p == "UI1280\\APP\\Preferences\\Beam": return R("SEM", "SEM.PRE", "config", True)
    if p == "UI1280\\APP\\Preferences\\Milling": return R("FIB", "FIB.PAT", "config")
    if p == "UI1280\\APP\\Preferences\\Stage": return R("SEM", "SEM.STG.MOVE", "config", True)
    m = re.match(r"UI1280\\APP\\Preferences\\(?:(EBeam|IBeam)\\)?MUI\\\w+$", p)
    if m:   # manual user interface (knob box) mappings: per beam, or host-wide when no beam segment
        if m.group(1) == "IBeam": return R("FIB", "FIB.CTRL", "calibration", conf="high")
        return R("SEM", "SEM.CTRL", "calibration", m.group(1) is None, "high" if m.group(1) else "medium")
    m = re.match(r"UI1280\\APP\\Preferences\\(EBeam|IBeam)\\(Mouse|Scan)$", p)
    if m:
        et = "SEM" if m.group(1) == "EBeam" else "FIB"
        return R(et, f"{et}.CTRL", "calibration" if m.group(2) == "Mouse" else "config", conf="high")
    if re.match(r"UI1280\\APP\\Preferences\\(Beam\\)?(EBeam\\)?(HV|Spot|Mag)(\\.*)?$", p) or \
       re.match(r"UI1280\\APP\\Preferences\\(EBeam|IBeam)\\(HV|Spot|Mag)(\\.*)?$", p):
        et = "FIB" if "\\IBeam\\" in p else "SEM"
        return R(et, f"{et}.PRE", "preset", conf="high" if "\\Beam\\" not in p else "low")
    if p.startswith("UI1280\\APP\\SFEG"): return R("SEM", "SEM.MODE", "tuning", True, "high")
    if p.startswith("UI1280\\APP\\SemAva"): return R("SEM", "SEM.AVA", "preset", conf="medium")
    if p == "UI1280\\APP\\StacomMapFile": return R("SEM", "SEM.STG.MOVE", "config", True)
    if p == "UI1280\\APP\\Stage":       return R("SEM", "SEM.STG.MOVE", "tuning", True)
    if p == "UI1280\\APP\\VideoPrinter": return R("SEM", "SEM.DISP", "config", True)
    if p == "UI1280\\APP\\WaferHandler":
        return R("SEM", "SEM.STG.WAFER", "counter" if name == "NoOfLoadCyclesPerformed" else "config", True)
    if p == "UI1280\\APP\\Z_FWD":       return R("SEM", "SEM.STG.EUC", "config", True)
    return None


_MUI_PATH = re.compile(r"^UI1280\\APP\\Preferences\\(?:(EBeam|IBeam)\\)?MUI\\(\w+)$")
_PRESET_PATH = re.compile(r"^UI1280\\APP\\Preferences\\(?P<beam>Beam\\)?(?P<b>EBeam\\|IBeam\\)?(?P<kind>HV|Spot|Mag)(?:\\(?P<mode>EDX|Search|UHR))?$")
_SLOT = re.compile(r"^(Factory)?Preset_(\d+)$")
_SEMAVA = re.compile(r"^Preset(Name|Stat)(\d+)$")


def registry_unit(name: str, path: str):
    if re.search(r"Voltage$|Volts", name) and "Steps" not in name: return "V", "name"
    if "\\Delays" in path and name.endswith(("UHR", "Search", "EDX")) : return "ms", "inferred"
    return None, None


def build_registry_definitions(leaves: list[RegLeaf], excluded: list, include_prefs: bool = False) -> list[dict]:
    # ---- pass 1: skip rules & binary -----------------------------------------------------------------
    keep: list[RegLeaf] = []
    for lf in leaves:
        if lf.is_binary:
            excluded.append(dict(source="UI1280reg.txt", id=lf.full, name=lf.name, reason="binary blob (not importable)"))
            continue
        why = next((w for rx, w in SKIP_RULES if re.search(rx, lf.path)), None)
        if lf.path == "UI1280\\APP\\Stage" and lf.name.startswith("StageProgressDlgPos"):
            why = "UI layout"
        if lf.path == "UI1280\\APP" and lf.name in ("InstallDir", "InstallFolder"):
            why = "install path"
        if why:
            excluded.append(dict(source="UI1280reg.txt", id=lf.full, name=lf.name, reason=why))
        else:
            keep.append(lf)
    # ---- pass 2: pair 'Factory*' with its live twin ------------------------------------------------------
    by_key = {(lf.path, lf.name): lf for lf in keep}
    factory_of: dict[tuple, RegLeaf] = {}
    drop: set[tuple] = set()
    for lf in keep:
        # key-level twin:  ...\Factory Defaults\X  <->  ...\Settings\X
        if "\\Factory Defaults" in lf.path:
            tw = (lf.path.replace("\\Factory Defaults", "\\Settings"), lf.name)
            if tw in by_key:
                factory_of[tw] = lf; drop.add((lf.path, lf.name)); continue
        # name-level twin: FactoryX <-> X   (and FactoryPreset_NN <-> Preset_NN)
        if lf.name.startswith("Factory"):
            tw = (lf.path, lf.name[len("Factory"):])
            if tw in by_key:
                factory_of[tw] = lf; drop.add((lf.path, lf.name))
    # SemAvaFactoryPresets\PresetNameN -> SemAva\PresetNameN
    for lf in keep:
        if lf.path.endswith("SemAvaFactoryPresets"):
            tw = (lf.path.replace("SemAvaFactoryPresets", "SemAva"), lf.name)
            if tw in by_key:
                factory_of[tw] = lf; drop.add((lf.path, lf.name))
    # ---- pass 3: list-level type unification for preset tables ----------------------------------------------
    list_types: dict[tuple, str] = collections.defaultdict(lambda: "int")
    for lf in keep:
        m = _PRESET_PATH.match(lf.path)
        if m and _SLOT.match(lf.name):
            if infer_type(lf.raw)[0] == "float":
                list_types[(lf.path, "list")] = "float"
    defs: list[dict] = []
    for lf in keep:
        key = (lf.path, lf.name)
        if key in drop:
            continue
        spec = map_registry(lf.path, lf.name)
        if spec is None:
            excluded.append(dict(source="UI1280reg.txt", id=lf.full, name=lf.name, reason="no mapping rule (unclassified)"))
            continue
        dtype, v = infer_type(lf.raw)
        table = row_key = col_key = None
        code = "REG." + ".".join(slug(s) for s in lf.path.split("\\")) + "." + (slug(lf.name) or "default")
        display = humanize_camel(lf.name) if lf.name else "Unnamed value"
        access = "adjustable"
        # ---- table-cell routing -------------------------------------------------------------------------------
        mp = _PRESET_PATH.match(lf.path)
        mm = _MUI_PATH.match(lf.path)
        if mp and _SLOT.match(lf.name):
            kind, mode = mp.group("kind").upper(), (mp.group("mode") or "DEFAULT").upper()
            is_fib = mp.group("b") == "IBeam\\"
            is_alt = bool(mp.group("beam"))
            tcode = "FIB_PRESET_MAG" if is_fib else f"SEM_PRESET_{kind}" + ("_ALT" if is_alt else "")
            row_key, col_key, table = _SLOT.match(lf.name).group(2).zfill(2), mode, tcode
            code = f"{tcode}.{mode}.{row_key}"
            dtype = list_types[(lf.path, "list")]
            display = f"{kind.title()} preset {row_key} ({mode.title()})"
        elif mm:
            beam, ctrl = mm.group(1), mm.group(2)
            tcode = "SEM_MUI_HOST" if beam is None else f"{'SEM' if beam == 'EBeam' else 'FIB'}_MUI"
            col_key = lf.name or "EXTRA"
            row_key, table = ctrl, tcode
            code = f"{tcode}.{ctrl}.{col_key}"
            display = f"{ctrl} - {humanize_camel(col_key)}"
            if col_key.startswith("Factory"):
                access = "fixed"
            if col_key == "Knob":
                access = "service"
        elif lf.path.endswith("\\SemAva") and _SEMAVA.match(lf.name):
            k, n = _SEMAVA.match(lf.name).groups()
            if int(n) <= 15:
                table, row_key, col_key = "SEM_AVA_PRESET", str(int(n)), "NAME" if k == "Name" else "STAT"
                code = f"SEM_AVA_PRESET.{n}.{col_key}"
                display = f"AVA preset {n} - {'name' if k == 'Name' else 'status'}"
            else:
                spec = R("SEM", "SEM.AVA", "unused", conf="low")   # stray 'PresetName4266' in the export
                display = f"Stray key {lf.name} (out of range)"
        # ---- value assembly -----------------------------------------------------------------------------------------
        vn = vt = fn = ft = None
        if dtype in ("int", "float", "bool"):
            vn = fmt_num(v) if dtype != "float" else v
        else:
            vt = v or None
        fac = factory_of.get(key)
        if fac:
            fdt, fv = infer_type(fac.raw)
            if fdt in ("int", "float", "bool"): fn = fmt_num(fv) if fdt != "float" else fv
            else: ft = fv or None
        cls = spec["cls"]
        if cls == "counter":
            access = "auto"
        unit, usrc = registry_unit(lf.name, lf.path)
        if table and col_key in ("HV",) or (table and "PRESET_HV" in table):
            unit, usrc = "kV", "inferred"
        widget = "toggle" if dtype == "bool" else "text" if dtype == "text" else "readonly" if cls == "counter" else "number"
        defs.append(dict(
            et=spec["et"], group=spec["group"], code=code, vendor_name=lf.name or None, display_name=display,
            description=None, param_class=cls, data_type=dtype, unit=unit, unit_source=usrc, access_level=access,
            applicability=[], shared_hardware=spec["shared"], adjustment_no=None, table=table, row_key=row_key,
            col_key=col_key, source_file="UI1280reg.txt", source_kind="reg", source_slot=None, source_path=lf.full,
            source_line=lf.line, vendor_flags=None, vendor_comment=None, semantics_known=True,
            assign_basis=spec["basis"], assign_conf=spec["conf"], enum=None, ui_widget=widget,
            value_num=vn, value_text=vt, factory_num=fn, factory_text=ft,
            limit_min_code=None, limit_max_code=None, limit_source=None))
    return defs


# ======================================================================= assemble ====================
def build_catalog(fib_rows: list[MdRow], sem_rows: list[MdRow], reg_leaves: list[RegLeaf]) -> dict:
    excluded: list[dict] = []
    defs = build_md_definitions(fib_rows, "FIB", excluded)
    defs += build_md_definitions(sem_rows, "SEM", excluded)
    defs += build_registry_definitions(reg_leaves, excluded)
    nlimits = derive_limits(defs)
    # ---- de-duplicate codes per equipment type ----------------------------------------------------------
    seen = collections.Counter((d["et"], d["code"]) for d in defs)
    dup = {k for k, v in seen.items() if v > 1}
    for d in defs:
        if (d["et"], d["code"]) in dup:
            d["code"] = f"{d['code']}#{d['source_kind'][0]}{d['source_slot'] if d['source_slot'] is not None else d['source_line']}"
    # ---- sort order = vendor file order -----------------------------------------------------------------
    for i, d in enumerate(sorted(defs, key=lambda d: (d["et"], d["source_file"], d["source_line"])), 1):
        d["sort_order"] = i
    # limit codes may have been renamed by dedup; refresh
    stats = dict(
        definitions=len(defs), limits_derived=nlimits,
        by_type=dict(collections.Counter(d["et"] for d in defs)),
        by_source=dict(collections.Counter((d["et"], d["source_file"]) .__str__() for d in defs)),
        by_class=dict(collections.Counter((d["et"], d["param_class"]).__str__() for d in defs)),
        by_access=dict(collections.Counter(d["access_level"] for d in defs)),
        low_confidence=sum(1 for d in defs if d["assign_conf"] == "low"),
        unnamed=sum(1 for d in defs if not d["semantics_known"] or d["param_class"] == "undocumented"),
        excluded=dict(collections.Counter(e["reason"] for e in excluded)), excluded_total=len(excluded))
    return dict(
        groups=[dict(et=e, code=c, label=l, parent=(c.rsplit(".", 1)[0] if c.count(".") > 1 else None), sort_order=i)
                for i, (e, c, l) in enumerate(T.GROUPS, 1)],
        tables=T.TABLES, definitions=defs, excluded=excluded, stats=stats)
