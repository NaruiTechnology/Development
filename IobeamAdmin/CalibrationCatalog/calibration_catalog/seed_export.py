"""Turn a built catalog (catalog_builder.build_catalog) into the JSON that fn_seed_calibration_catalog() consumes,
and wrap it as an idempotent SQL file."""
from __future__ import annotations
import json

VENDOR = "FEI / Thermo Scientific"
DOCUMENTS = {
    "icmd.TXT": "icmd.TXT (icMDava.TXT - FEI ion-column machine data)",
    "md.TXT": "md.TXT (MDFEI.TXT + MD50N.TXT - FEI electron-column and stage machine data)",
    "UI1280reg.txt": "UI1280reg.txt (registry export HKLM\\Software\\Microscope)",
}
_SEED_TAG = "calibration_seed"


def _typed(dtype: str, num, text, has_enum: bool):
    if dtype == "text":
        return text
    if num is None:
        return None
    if dtype == "bool":
        return bool(num)
    if dtype == "int":
        return int(num)
    return float(num)


def _reference(d: dict) -> str:
    if d["source_kind"] == "reg":
        return f"registry {d['source_path']} (line {d['source_line']})"
    comment = (d.get("vendor_comment") or "").strip()
    ref = f"{d['source_kind']} slot {d['source_slot']} (line {d['source_line']})"
    return f"{ref} /* {comment} */" if comment else ref


def to_seed(cat: dict) -> dict:
    groups = [dict(equipment_type=g["et"], group_code=g["code"], parent_code=g["parent"], label=g["label"],
                   sort_order=g["sort_order"]) for g in cat["groups"]]
    tables = [dict(equipment_type=t["et"], table_code=t["code"], group_code=t["group"], label=t["label"], kind=t["kind"],
                   row_header=t.get("row_header"), col_header=t.get("col_header"), note=t.get("note"),
                   layout=dict(rows=t["rows"], cols=t["cols"])) for t in cat["tables"]]
    defs = []
    for d in cat["definitions"]:
        enum = d.get("enum")
        vtype = {"float": "number", "int": "integer", "bool": "boolean", "text": "text"}[d["data_type"]]
        options = None
        if enum and d["ui_widget"] == "select":
            vtype = "enum"
            options = [dict(value=int(k), label=str(v)) for k, v in sorted(enum.items(), key=lambda kv: int(kv[0]))]
        default = _typed(d["data_type"], d["factory_num"], d["factory_text"], bool(enum))
        defs.append(dict(
            equipment_type=d["et"], parameter_key=d["code"], group_code=d["group"], vendor_name=d["vendor_name"],
            display_name=d["display_name"], description=d["description"] or "", value_type=vtype, unit=d["unit"] or "",
            unit_source=d["unit_source"], limit_min_key=d["limit_min_code"], limit_max_key=d["limit_max_code"],
            default_value=default, enum_options=options, param_class=d["param_class"], access_level=d["access_level"],
            is_read_only=d["access_level"] in ("fixed", "auto") or d["param_class"] in ("identity", "counter"),
            shared_hardware=d["shared_hardware"], applicability=d["applicability"], ui_widget=d["ui_widget"],
            adjustment_no=d["adjustment_no"], table_code=d["table"], row_key=d["row_key"], col_key=d["col_key"],
            source_vendor=VENDOR, source_document=DOCUMENTS.get(d["source_file"], d["source_file"]), source_url="",
            source_reference=_reference(d), source_kind=d["source_kind"], source_slot=d["source_slot"],
            source_path=d["source_path"], source_line=d["source_line"], vendor_flags=d["vendor_flags"],
            semantics_known=d["semantics_known"], assign_basis=d["assign_basis"], assign_conf=d["assign_conf"],
            sort_order=d["sort_order"]))
    return dict(groups=groups, tables=tables, definitions=defs)


def to_sql(seed: dict, header: str = "") -> str:
    body = json.dumps(seed, ensure_ascii=True, separators=(",", ":"))
    assert f"${_SEED_TAG}$" not in body
    return (f"{header}SET search_path TO ionbeam_asset, iobeam_admin, public;\n"
            f"SELECT ionbeam_asset.fn_seed_calibration_catalog(${_SEED_TAG}${body}${_SEED_TAG}$::jsonb);\n")
