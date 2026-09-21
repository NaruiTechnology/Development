"""Static taxonomy: parameter groups, table layouts, curated enumerations, unit rules.

Everything here is *derived from the vendor files' own comments* unless marked `inferred`.
"""
from __future__ import annotations

# ---------------------------------------------------------------- groups: (code, label)
# The parent is implied by the dotted code ('FIB.SRC.EXTR' -> parent 'FIB.SRC').
_G = {
    "FIB": [
        ("FIB.SYS", "Platform & hardware configuration"), ("FIB.SYS.IDENT", "Identity & firmware"),
        ("FIB.SYS.HW", "Hardware options"),
        ("FIB.SRC", "Ion source (Ga LMIS)"), ("FIB.SRC.SUPPR", "Suppressor"), ("FIB.SRC.EXTR", "Extractor"),
        ("FIB.SRC.HT", "Beam high tension"), ("FIB.SRC.FIL", "Filament & heating"),
        ("FIB.SRC.START", "Autostart"), ("FIB.SRC.EMIS", "Emission & source characteristics"),
        ("FIB.SRC.TRACK", "Emission tracking"), ("FIB.SRC.SPY", "IGSU spy (supply monitoring)"),
        ("FIB.SRC.LIFE", "Source lifetime counters"),
        ("FIB.OPT", "Column optics"), ("FIB.OPT.LENS", "Lenses L1 / L2"),
        ("FIB.OPT.ALIGN", "Alignment sensitivities"), ("FIB.OPT.MAG", "Magnification, rotation & working distance"),
        ("FIB.OPT.DEFL", "Deflection & AVA motor limits"), ("FIB.OPT.TILT", "Tilt"),
        ("FIB.OPT.SPOTDAC", "Spot-park DAC"),
        ("FIB.APT", "Apertures"), ("FIB.APT.LIMITS", "Aperture limits"),
        ("FIB.APT.PRESETS", "Aperture presets (AVA strip)"),
        ("FIB.IMG", "Imaging"), ("FIB.IMG.SIZE", "Output image sizes"), ("FIB.IMG.DELAY", "Scan delay factors"),
        ("FIB.IMG.BIAS", "Grid bias, contrast & brightness"), ("FIB.IMG.ACB", "Auto contrast/brightness (ACB)"),
        ("FIB.IMG.DET", "Ion detection (CDM / SED)"),
        ("FIB.PAT", "Patterning & milling"),
        ("FIB.GIS", "Gas injection (GIS)"), ("FIB.GIS.CFG", "GIS unit configuration"),
        ("FIB.GIS.LIFE", "GIS life counters"),
        ("FIB.VAC", "Vacuum"), ("FIB.CTRL", "Controls (MUI / mouse)"), ("FIB.PRE", "Presets"),
    ],
    "SEM": [
        ("SEM.SYS", "Platform & hardware configuration"), ("SEM.SYS.IDENT", "Identity & firmware"),
        ("SEM.SYS.JUMPER", "SDB jumper settings"), ("SEM.SYS.HW", "Hardware options"),
        ("SEM.SYS.LICENSE", "Key / licence options"), ("SEM.SYS.PUMP", "Pump-down & bake-out timing"),
        ("SEM.COL", "Electron column"), ("SEM.COL.CORR", "Column control correction"),
        ("SEM.COL.COEF", "Column control coefficients"), ("SEM.COL.DAC", "DAC & coil ranges"),
        ("SEM.COL.RANGE", "Operating ranges (min / max / default)"),
        ("SEM.COL.GUNSHIFT", "Gun shift correction table"), ("SEM.COL.GUNBIAS", "Gun bias array"),
        ("SEM.COL.SCAN", "Scan timing"), ("SEM.COL.SPOTDAC", "Spot-park DAC"),
        ("SEM.MODE", "SFEG mode switching (UHR / Search / EDX)"),
        ("SEM.DET", "Detectors"), ("SEM.DET.GRID", "Grid & front-end voltages"),
        ("SEM.DET.CB", "Contrast & brightness"), ("SEM.DET.ACB", "Auto contrast/brightness (ACB)"),
        ("SEM.DET.CDM", "CDM / SED / CEM settings"),
        ("SEM.STG", "Stage & motion"), ("SEM.STG.POS", "Positions, blocking & offsets"),
        ("SEM.STG.SERVO", "Axis servo parameters"), ("SEM.STG.SERVO2", "Axis limits & steps"),
        ("SEM.STG.BACKLASH", "Backlash & hysteresis"), ("SEM.STG.EUC", "Eucentric / auto-Z"),
        ("SEM.STG.HOLDER", "Sample holder"), ("SEM.STG.MOVE", "Move behaviour"),
        ("SEM.STG.LASER", "Laser navigation"), ("SEM.STG.WAFER", "Wafer handler"),
        ("SEM.AUTO", "Auto-functions"), ("SEM.AUTO.FOCUS", "AutoFocus"), ("SEM.AUTO.STIG", "AutoStig"),
        ("SEM.AUTO.DRIFT", "Drift control"),
        ("SEM.DISP", "Display & output devices"),
        ("SEM.PRE", "Presets (HV / spot / magnification)"), ("SEM.AVA", "SEM aperture (AVA) presets"),
        ("SEM.CTRL", "Controls (joystick / MUI / mouse)"), ("SEM.NEUT", "Charge neutraliser"),
        ("SEM.UND", "Undocumented slots (no vendor symbol)"),
        ("SEM.UND.0060", "Slots 60-69"), ("SEM.UND.0204", "Slots 204-667 (HT-headed correction tables)"),
        ("SEM.UND.0932", "Slots 932-1131"), ("SEM.UND.1160", "Slots 1160-1631"),
    ],
}
GROUPS = [(et, code, label) for et, lst in _G.items() for code, label in lst]

# ------------------------------------------------------------- table layouts
def _cols(spec):  # [(key,label,unit)]
    return [dict(key=k, label=l, unit=u) for k, l, u in spec]

AP_COLS = _cols([
    ("PICO_AMP", "Beam current", "pA"), ("L1", "Lens 1", None), ("L2", "Lens 2", None),
    ("STIG_SIN", "Stigmator sin", None), ("STIG_COS", "Stigmator cos", None),
    ("BSX", "Beam shift X", None), ("BSY", "Beam shift Y", None), ("HT", "High tension", "V"),
    ("SPOTSIZE", "Spot size", None), ("EXT", "Extractor", "V"),
    ("BAL_1_X", "Balance 1 X", None), ("BAL_1_Y", "Balance 1 Y", None),
    ("BAL_2_X", "Balance 2 X", None), ("BAL_2_Y", "Balance 2 Y", None),
    ("Q1_X", "Q1 X", None), ("Q1_Y", "Q1 Y", None),
    ("Q2_X", "Q2 X / AVA X position", None), ("Q2_Y", "Q2 Y / AVA Y position", None)])

SERVO_COLS = _cols([(k, k, u) for k, u in [
    ("OFFSET", None), ("SATLEV", "raw"), ("POSCRI", "raw"), ("SPECRI", "raw"), ("TIMCRI", "raw"),
    ("MAXFER", "raw"), ("OBSMOD", "raw"), ("KDC", "raw"), ("OK1", "raw"), ("OK2", "raw"),
    ("KP", "raw"), ("KV", "raw"), ("KFV", "raw"), ("KFA", "raw"), ("KI", "raw"), ("KFC", "raw"),
    ("JITLEV", "raw"), ("JITPR2", "raw"), ("OTH_ESW", None), ("HOM_ESW", None), ("PTPVEL", "raw"),
    ("PTPACC", "raw"), ("PTPACS", "raw"), ("VTRSH", "raw"), ("LAMBDA", "raw"), ("HOMVEL", "raw"),
    ("HOMACC", "raw"), ("HOMOFS", "raw"), ("QSTACC", "raw"), ("TIMOUT", "raw")]])
SERVO2_COLS = _cols([(k, k, u) for k, u in [
    ("MIN_STEP", "inc"), ("ESW_MARGIN", None), ("CTR_BACKLASH", None), ("CLAMP_DELAY", None),
    ("spare_6", None), ("spare_5", None), ("spare_4", None), ("spare_3", None), ("spare_2", None),
    ("spare_1", None)]])
PRESET_MODES = _cols([("DEFAULT", "Default", None), ("EDX", "EDX mode", None),
                      ("SEARCH", "Search mode", None), ("UHR", "UHR mode", None)])
MUI_COLS = _cols([("FactoryDefaultScaleFactor", "Factory scale factor", None),
                  ("FactorySensitivity", "Factory sensitivity", None),
                  ("Sensitivity", "Sensitivity", None), ("Knob", "Knob #", None),
                  ("EXTRA", "Unnamed value (vendor)", None)])
MUI_ROWS = ["BeamShiftX", "BeamShiftY", "Brightness", "Contrast", "FineFocus", "Focus",
            "Magnification", "StigX", "StigY"]
AXES6, AXES5 = ["X", "Y", "Z", "T", "R", "LL"], ["X", "Y", "Z", "T", "R"]
AP_ROLES = {**{n: "preset" for n in range(1, 12)}, 12: "alignment", 13: "low_ht_low_mag"}
SLOTS20 = [f"{n:02d}" for n in range(20)]

# code -> spec.  kind: 'matrix' | 'list'
TABLES = [
    dict(et="FIB", code="FIB_APERTURES", group="FIB.APT.PRESETS", label="Aperture presets (AVA strip)",
         kind="matrix", row_header="Aperture #", col_header="Parameter",
         rows=[dict(key=str(n), label=f"Aperture {n}", role=AP_ROLES[n]) for n in range(1, 14)],
         cols=AP_COLS,
         note="Rows 1-11 = presets, 12 = alignment, 13 = low HT / low magnification (roles inferred from "
              "the vendor's section comments; IONI_NO_APER_PRESETS = 11)."),
    dict(et="SEM", code="SEM_STAGE_SERVO", group="SEM.STG.SERVO", label="Stage axis servo parameters",
         kind="matrix", row_header="Axis", col_header="MD_8I_* parameter",
         rows=[dict(key=a, label=a) for a in AXES6], cols=SERVO_COLS,
         note="OFFSET/OTH_ESW/HOM_ESW are [nm] for X,Y,Z and [uDeg] for T,R. LL (load-lock arm) is 'not present' on this system."),
    dict(et="SEM", code="SEM_STAGE_SERVO2", group="SEM.STG.SERVO2", label="Stage axis limits & steps",
         kind="matrix", row_header="Axis", col_header="MD_8I_* parameter",
         rows=[dict(key=a, label=a) for a in AXES5], cols=SERVO2_COLS, note=None),
    dict(et="SEM", code="SEM_STAGE_BACKLASH", group="SEM.STG.BACKLASH", label="Stage backlash & hysteresis",
         kind="matrix", row_header="Axis", col_header="Parameter",
         rows=[dict(key=a, label=a) for a in AXES5],
         cols=_cols([("BACKLASH", "Backlash", "um|uDeg"), ("HYSTERESIS", "Hysteresis", "um|uDeg")]),
         note="X,Y,Z in micrometres; T,R in micro-degrees."),
]
for _n, _lab in (("HV", "High-tension presets"), ("SPOT", "Spot-size presets"), ("MAG", "Magnification presets")):
    TABLES.append(dict(et="SEM", code=f"SEM_PRESET_{_n}", group="SEM.PRE", label=f"SEM {_lab} (per column mode)",
                       kind="list", row_header="Slot", col_header="Mode", rows=[dict(key=k, label=f"Slot {k}") for k in SLOTS20],
                       cols=PRESET_MODES, note="Registry: Preferences\\EBeam\\" + _n.title()))
    TABLES.append(dict(et="SEM", code=f"SEM_PRESET_{_n}_ALT", group="SEM.PRE", label=f"SEM {_lab} (alternate registry location)",
                       kind="list", row_header="Slot", col_header="Mode", rows=[dict(key=k, label=f"Slot {k}") for k in SLOTS20],
                       cols=PRESET_MODES[:1], note="Registry: Preferences\\Beam\\... - duplicates the primary location in this export; "
                                                   "which one xP 2.25 reads is not documented."))
TABLES.append(dict(et="FIB", code="FIB_PRESET_MAG", group="FIB.PRE", label="FIB magnification presets", kind="list",
                   row_header="Slot", col_header="Mode", rows=[dict(key=k, label=f"Slot {k}") for k in SLOTS20],
                   cols=PRESET_MODES[:1], note="Registry: Preferences\\IBeam\\Mag"))
for _et, _code, _grp, _lab in (("SEM", "SEM_MUI", "SEM.CTRL", "SEM manual-interface (MUI) knob mapping"),
                                ("FIB", "FIB_MUI", "FIB.CTRL", "FIB manual-interface (MUI) knob mapping"),
                                ("SEM", "SEM_MUI_HOST", "SEM.CTRL", "MUI host-wide factory defaults")):
    TABLES.append(dict(et=_et, code=_code, group=_grp, label=_lab, kind="matrix", row_header="Control",
                       col_header="Setting", rows=[dict(key=r, label=r) for r in MUI_ROWS],
                       cols=MUI_COLS if _code != "SEM_MUI_HOST" else MUI_COLS[:2], note=None))
TABLES.append(dict(et="SEM", code="SEM_AVA_PRESET", group="SEM.AVA", label="SEM aperture (AVA) preset names", kind="matrix",
                   row_header="Preset", col_header="Field",
                   rows=[dict(key=str(n), label=f"Preset {n}") for n in range(1, 16)],
                   cols=_cols([("NAME", "Name", None), ("STAT", "Status", None)]),
                   note="Registry: Preferences\\SemAva. Factory names come from SemAvaFactoryPresets."))

# ---------------------------------------------------- curated enumerations (from vendor comments)
_GIS = {0: "None", 1: "PT (GIS I)", 2: "EE (GIS I)", 3: "PT (GIS II)", 4: "EE (GIS II)", 5: "MVD",
        6: "INS", 7: "User-edit", 99: "CIV", 111: "Unknown name"}
_CAD = {1: "Knights RS232", 2: "Kinetek RS232", 3: "Knights Net", 4: "Knights Net (debug)"}
ENUMS = {
    "IONI_LENS_TYPE": {0: "2Li column", 1: "Prelens (AVA)", 2: "Magnum column"},
    "IONI_DEFL_TYPE": {1: "Decade"},
    "MCTRL_CFG": {0: "Off", 1: "Auto detector switch E-I"},
    "IONI_XL_TYPE": {3: "XL30", 4: "XL40", 5: "XL50"},
    "IONI_INSTR_TYPE": {0: "Sierra", 1: "StH", 2: "Cas", 3: "FIB600"},
    "IONI_OVERLAY_CARD": {0: "No", 1: "IM1280", 2: "IM1280 + RTP", 3: "Coreco"},
    "IONI_DIGIO_TYPE": {0: "None", 1: "1 card, 24 bit", 2: "2 cards, 24 bit", 3: "1 card, 96 bit"},
    "IONI_DSPG_TYPE": {0: "None", 1: "FIB611", 2: "XL", 18: "XL slow scan"},
    "IONI_STAGE_TYPE": {0: "No stage", 1: "PCX", 2: "PCX + encoders", 3: "XL30 GCS", 4: "XL40",
                        5: "XL 8 inch", 6: "XL30 SMCB"},
    "IONI_CAD_TYPE": {0: "None", **_CAD}, "IONI_DET_USED": {0: "E", 1: "I"},
    "IGSU_SPY_MODE": {1: "Monitor", 2: "Reset", 3: "Correct", 4: "Full diagnostics", 6: "Off"},
    "IGSU_SPY_FIL_MODE": {0: "If needed", 1: "On"},
    **{f"GIS_UNIT_{i}": _GIS for i in range(1, 7)},
    "IMD_STAGE": {0: "Manual", 4: "XL30 SMCB (50x50)", 5: "XL50 SMCB (200x200)", 6: "XL20 GCS (20x20)",
                  7: "XL30 GCS (50x50)", 8: "XL40 GCS (150x150)", 9: "XL30 SMCB (100x100)",
                  10: "XL30 SMCB-T (50x50 + tilt)", 11: "TFH SMCB (50x100)"},
    "IMD_OBJ_LENS": {0: "Flat", 1: "Con", 2: "PFC"}, "IMD_GUN_TYPE": {0: "W", 1: "LaB6"},
    "IMD_VAC_CHAMBER": {0: "XL20", 1: "Large"}, "IMD_PEN_GAUGE": {0: "Edwards", 1: "Leybold"},
    "IMD_SDB_TMP": {0: "ODP", 1: "Turbo"}, "IMD_SDB_VIDEO_PAL": {0: "NTSC", 1: "PAL"},
    "IMD_SDB_60_HZ": {0: "50 Hz", 1: "60 Hz"},
    "IMD_NEW_LOADLOCK": {0: "Mk I", 1: "Mk II (new loadlock)", 2: "Mk III/IV (stage Z clamps)",
                         3: "Mk III (improved arm drive)", 4: "Mk V (non-endless rotation)"},
    "IMD_GCS_VERSION_NO": None,
}
ENUMS = {k: v for k, v in ENUMS.items() if v}

# ------------------------------------------------------------------ unit rules
# (regex on symbol, unit, source)   source: 'name' = encoded in the symbol, 'inferred' = domain knowledge
UNIT_RULES = [
    (r"_PICO_AMP$", "pA", "name"), (r"UAMP_HRS$", "uA*h", "name"),
    (r"^IONF_GIS\d_LIFE$", "s", "vendor"), (r"(_SEC|_SECONDS)$", "s", "name"),
    (r"^IONF_(SUP|EXT)_(HEAT|USED|MIN|MAX|CAL)$", "V", "inferred"),
    (r"^IONF_HT_(MIN|MAX|MAX_REF)$", "V", "inferred"), (r"^IONF_AP_(HT|EXT)$", "V", "inferred"),
    (r"^IONF_DLT_E_HT_\d$", "V", "inferred"), (r"^IONF_IFIL_", "A", "inferred"),
    (r"^IONF_APER_(MIN|MAX)$", "pA", "inferred"), (r"^IONF_WD_(MIN|MAX|DEF)$", "mm", "name"),
    (r"^IONF_(ROT_MIN|ROT_MAX|ROT_OFFSET)$", "deg", "name"), (r"^IONF_(EBEAM|IBEAM|STEP)_TILT$", "deg", "inferred"),
    (r"^IONF_AVA_M(IN|AX)_[XY]$", "steps", "vendor"), (r"^IONF_DEFL_(UP|HYST)$", "%", "vendor"),
    (r"^IONF_MAG_MAX_PERC$", "%", "name"), (r"^IONF_(PHOTO|SCREEN|VIDEO)_IMG_SIZE_Y$", "mm", "vendor"),
    (r"^IONF_BIAS_(ELEC|ION)$", "V", "inferred"),
    (r"^MD_HIGHTENS_", "V", "inferred"), (r"^MD_WORKDIST_", "mm", "name"), (r"^MD_TILTANG_", "deg", "name"),
    (r"^MD_SCANROT_", "deg", "name"), (r"^MD_IMAGESIZE_(MIN|MAX|DEF)$", "mm", "vendor"),
    (r"^MD_(TIFF|PHOTO|SCREEN|VIDEO)_IMAGE_SIZE_Y$", "mm", "vendor"), (r"^MD_FRONT_CED_", "V", "vendor"),
    (r"^MD_GRID_(MCP|CED)_(MIN|MAX)$", "V", "inferred"), (r"^IMD_PURGE_TIME$", "s", "vendor"),
    (r"^IMD_4QUAD_DELAY$", "ms", "vendor"), (r"^IMD_TRAFICL_PC_SEC$", "s", "vendor"),
    (r"^IMD_BAKE_", "min", "vendor"), (r"^MD_STAGE_ROT_[XY]_OFF$", "mm", "vendor"),
    (r"^MD_STAGE_TILT_COL_DIST$", "mm", "vendor"), (r"^MD_WORKDIST_EUC$", "mm", "vendor"),
]
VENDOR_UNIT_NORMALISE = {"nm": "nm", "raw": "raw", "uDeg": "udeg", "inc": "inc", "um": "um", "mm": "mm",
                         "off": "raw"}

# ints that are jumpers / options: shown as toggles when every observed value is 0/1
TOGGLE_INT_RANGES_SEM = [(10, 41), (70, 93)]
