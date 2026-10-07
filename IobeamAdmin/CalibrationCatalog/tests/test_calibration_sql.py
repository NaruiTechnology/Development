"""Behavioural tests of the stored functions in 003_calibration_schema.sql against a real PostgreSQL."""
import json, os
import pytest

psycopg2 = pytest.importorskip("psycopg2", reason="calibration SQL tests need psycopg2-binary")

ADMIN, DEV, SUPER, USER = 3, 2, 1, 0


def upsert(db, eq, et, values, role=SUPER, **kw):
    return db.call("fn_upsert_equipment_calibration",
                   dict(equipment_id=eq, equipment_type=et, values=values, actor_role=role, **kw))


def get(db, eq, et, **kw):
    return db.call("fn_get_equipment_calibration", dict(equipment_id=eq, equipment_type=et, **kw))


def val(bundle, key):
    return next((v["value"] for v in bundle["values"] if v["parameter_key"] == key), None)


# ------------------------------------------------------------------------------------------ seed
def test_seed_counts_and_no_credentials(db):
    assert db.one("select count(*) from ionbeam_asset.calibration_parameter_definition where equipment_type='FIB'") == 501
    assert db.one("select count(*) from ionbeam_asset.calibration_parameter_definition where equipment_type='SEM'") == 1934
    assert db.one("select count(*) from ionbeam_asset.calibration_table") == 15
    bad = db.one("""select count(*) from ionbeam_asset.calibration_parameter_definition
                    where parameter_key ~* 'pswd|password|login|\\.usr\\.' or vendor_name ~* 'pswd'""")
    assert bad == 0


def test_seed_is_idempotent_and_keeps_human_edits(db, pg):
    seed = open(os.path.join(os.path.dirname(__file__), "..", "..", "Sql", "004_calibration_seed.sql"), encoding="utf-8").read()
    before = db.one("select count(*) from ionbeam_asset.calibration_parameter_definition")
    did = db.one("select id from ionbeam_asset.calibration_parameter_definition where parameter_key='MD_I0045' and equipment_type='SEM'")
    r = db.call("fn_update_calibration_definition", dict(id=did, actor_role=ADMIN, display_name="Gun bias spare",
                                                         description="named by service", semantics_known=True))
    assert r["definition"]["review_state"] == "reviewed"                                    # any human edit protects the text from re-seeding
    assert r["ok"] and r["definition"]["display_name"] == "Gun bias spare"
    db.cur.execute(seed)                                   # re-run the generated seed
    assert db.one("select count(*) from ionbeam_asset.calibration_parameter_definition") == before
    row = db.one("select to_jsonb(d) from ionbeam_asset.calibration_parameter_definition d where id=%s", (did,))
    assert row["display_name"] == "Gun bias spare" and row["assign_basis"] == "manual" and row["semantics_known"] is True
    assert db.one("select count(*) from ionbeam_asset.calibration_definition_change where definition_id=%s", (did,)) == 1


def test_definition_edit_needs_admin(db):
    r = db.call("fn_update_calibration_definition", dict(id=1, actor_role=DEV, display_name="x"))
    assert r == {"ok": False, "error": "forbidden_role", "message": "editing the catalog needs role 3 (admin)"}


def test_types_are_isolated(db, equipment):
    fib_keys = db.one("select array_agg(parameter_key) from ionbeam_asset.calibration_parameter_definition where equipment_type='FIB' and parameter_key like 'IONF_SUP_USED'")
    r = upsert(db, equipment[0], "SEM", [dict(parameter_key="IONF_SUP_USED", value=500)], role=ADMIN)
    assert r["ok"] is False and r["errors"][0]["code"] == "unknown_parameter"


# ------------------------------------------------------------------------------------------ groups / get
def test_groups_tree(db, equipment):
    g = db.call("fn_list_calibration_groups", dict(equipment_type="FIB", equipment_id=equipment[0]))
    assert g["ok"]
    by = {x["group_code"]: x for x in g["groups"]}
    assert by["FIB.APT.PRESETS"]["table_cells"] == 234 and by["FIB.APT.PRESETS"]["tables"][0]["table_code"] == "FIB_APERTURES"
    assert by["FIB.SRC"]["total_parameters"] >= by["FIB.SRC.EXTR"]["parameters"] > 0      # roll-up
    sem = db.call("fn_list_calibration_groups", dict(equipment_type="SEM"))
    assert sem["quality"]["undocumented"] >= 700                                           # vendor-undocumented slots are counted
    assert db.call("fn_list_calibration_groups", dict(equipment_type="XYZ"))["ok"] is False


def test_get_filters(db, equipment):
    a = get(db, equipment[0], "FIB", group_code="FIB.SRC", limit=1000)
    assert a["ok"] and a["total"] == len(a["definitions"]) > 20
    assert all(d["group_code"].startswith("FIB.SRC") for d in a["definitions"])
    assert all(d["category"].startswith("Ion source") for d in a["definitions"])
    q = get(db, equipment[0], "FIB", q="extractor")
    assert q["total"] >= 1
    u = get(db, equipment[0], "SEM", undocumented=True, limit=5)
    assert u["total"] >= 700 and all(not d["semantics_known"] or d["param_class"] == "undocumented" for d in u["definitions"])
    assert get(db, 999999, "FIB") == {"ok": False, "error": "equipment not found"}
    k = get(db, equipment[0], "FIB", keys=["IONF_SUP_USED"])
    assert [d["parameter_key"] for d in k["definitions"]] == ["IONF_SUP_USED"] and k["profile"] is None


def test_definition_shape_matches_repository_contract(db, equipment):
    d = get(db, equipment[0], "FIB", keys=["IONI_LENS_TYPE"])["definitions"][0]
    for key in ("id", "equipment_type", "parameter_key", "category", "display_name", "description", "value_type", "unit",
                "minimum_value", "maximum_value", "default_value", "enum_values", "source_vendor", "source_document",
                "source_url", "source_reference", "is_read_only", "sort_order"):
        assert key in d, key
    assert d["value_type"] == "enum" and isinstance(d["enum_values"], list) and d["enum_options"][0].keys() == {"value", "label"}


# ------------------------------------------------------------------------------------------ write path
def test_write_read_revisions_history(db, equipment):
    fib = equipment[0]
    r = upsert(db, fib, "FIB", [dict(parameter_key="IONF_SUP_USED", value=612.5), dict(parameter_key="IONF_WD_DEF", value=19)],
               actor_user_id=1, reason="commissioning")
    assert r["ok"] and r["result"]["revision"] == 1 and r["result"]["changed"] == 2
    assert r["profile"]["revision"] == 1 and r["profile"]["profile_name"] == "default" and r["profile"]["is_active"]
    b = get(db, fib, "FIB", group_code="FIB.SRC")
    assert val(b, "IONF_SUP_USED") == 612.5
    same = upsert(db, fib, "FIB", [dict(parameter_key="IONF_SUP_USED", value=612.5)])
    assert same["result"]["changed"] == 0 and same["result"]["revision"] == 1               # no-op writes no revision
    r2 = upsert(db, fib, "FIB", [dict(parameter_key="IONF_SUP_USED", value=600)], expected_revision=1, reason="tweak")
    assert r2["result"]["revision"] == 2
    h = db.call("fn_list_equipment_calibration_history", dict(equipment_id=fib, equipment_type="FIB"))
    assert [x["revision"] for x in h] == [2, 1] and h[0]["snapshot"] == {"IONF_SUP_USED": 600} and h[0]["reason"] == "tweak"
    assert h[0]["changes"] == [{"parameter_key": "IONF_SUP_USED", "old": 612.5, "new": 600}]
    hk = db.call("fn_list_equipment_calibration_history", dict(equipment_id=fib, equipment_type="FIB", parameter_key="IONF_WD_DEF"))
    assert [x["revision"] for x in hk] == [1]
    with pytest.raises(psycopg2.Error):
        db.cur.execute("update ionbeam_asset.calibration_revision set reason='tamper'")
    db.conn.rollback() if not db.conn.autocommit else None
    db.cur.execute("SET search_path TO iobeam_admin, ionbeam_asset, public")


def test_optimistic_lock(db, equipment):
    r = upsert(db, equipment[0], "FIB", [dict(parameter_key="IONF_WD_DEF", value=21)], expected_revision=0)
    assert r["ok"] is False and r["error"] == "revision_conflict" and r["current_revision"] >= 2


def test_validation_is_atomic_and_creates_nothing(db, equipment):
    sem = equipment[1]
    r = upsert(db, sem, "SEM", [dict(parameter_key="IMD_4QUAD_DELAY", value=1.5),          # int expected
                                dict(parameter_key="NOPE", value=1),
                                dict(parameter_key="IMD_STAGE", value=99)], role=ADMIN)
    assert r["ok"] is False and r["error"] == "validation_failed"
    assert {e["code"] for e in r["errors"]} == {"invalid_value", "unknown_parameter"}
    assert db.one("select count(*) from ionbeam_asset.calibration_profile where equipment_id=%s and equipment_type='SEM'", (sem,)) == 0


def test_enum_bool_text(db, equipment):
    sem = equipment[1]
    ok = upsert(db, sem, "SEM", [dict(parameter_key="IMD_STAGE", value=4)], role=DEV)
    assert ok["ok"], ok
    bad = upsert(db, sem, "SEM", [dict(parameter_key="IMD_STAGE", value=77)], role=DEV)
    assert bad["ok"] is False and "must be one of" in bad["errors"][0]["message"]
    tog = db.one("select parameter_key from ionbeam_asset.calibration_parameter_definition where equipment_type='SEM' and value_type='boolean' and semantics_known and assign_conf <> 'low' order by id limit 1")
    assert upsert(db, sem, "SEM", [dict(parameter_key=tog, value="true")], role=ADMIN, acknowledge_risk=True)["ok"]
    assert upsert(db, sem, "SEM", [dict(parameter_key=tog, value=2)], role=ADMIN, acknowledge_risk=True)["ok"] is False
    txt = db.one("select parameter_key from ionbeam_asset.calibration_parameter_definition where equipment_type='SEM' and value_type='text' limit 1")
    assert upsert(db, sem, "SEM", [dict(parameter_key=txt, value="COM7")], role=ADMIN, acknowledge_risk=True)["ok"]
    assert upsert(db, sem, "SEM", [dict(parameter_key=txt, value=5)], role=ADMIN, acknowledge_risk=True)["ok"] is False


def test_role_and_risk_rules(db, equipment):
    fib = equipment[0]
    # adjustable: role 1 ok, role 0 rejected
    assert upsert(db, fib, "FIB", [dict(parameter_key="IONF_WD_DEF", value=18)], role=USER)["errors"][0]["code"] == "forbidden_role"
    # service parameter needs role 2
    svc = "IONI_LENS_TYPE"
    assert upsert(db, fib, "FIB", [dict(parameter_key=svc, value=1)], role=SUPER)["errors"][0]["code"] == "forbidden_role"
    assert upsert(db, fib, "FIB", [dict(parameter_key=svc, value=1)], role=DEV)["ok"]
    # fixed parameter: admin + acknowledgement
    fixed = "IONI_MD_INITIALIZED"
    assert upsert(db, fib, "FIB", [dict(parameter_key=fixed, value=3)], role=DEV)["errors"][0]["code"] == "forbidden_role"
    r = upsert(db, fib, "FIB", [dict(parameter_key=fixed, value=3)], role=ADMIN)
    assert r["ok"] is False and r["errors"][0]["code"] == "risk_ack_required"
    assert upsert(db, fib, "FIB", [dict(parameter_key=fixed, value=3)], role=ADMIN, acknowledge_risk=True)["ok"]
    # vendor-undocumented slot: even a service user must acknowledge
    und = "IMD_L6_GUN_BIAS_02"
    r = upsert(db, equipment[1], "SEM", [dict(parameter_key=und, value=5)], role=DEV)
    assert r["ok"] is False and r["errors"][0]["code"] == "risk_ack_required" and "not document" in r["errors"][0]["message"]
    assert upsert(db, equipment[1], "SEM", [dict(parameter_key=und, value=5)], role=DEV, acknowledge_risk=True)["ok"]


def test_limits_static_and_from_other_parameters(db, equipment):
    fib = equipment[0]
    assert upsert(db, fib, "FIB", [dict(parameter_key="IONF_SUP_MIN", value=100), dict(parameter_key="IONF_SUP_MAX", value=800)],
                  role=ADMIN, acknowledge_risk=True)["ok"]           # the vendor limits are 'fixed' values
    hi = upsert(db, fib, "FIB", [dict(parameter_key="IONF_SUP_USED", value=900)])
    assert hi["ok"] is False and hi["errors"][0]["code"] == "out_of_range" and "[100 .. 800]" in hi["errors"][0]["message"]
    assert upsert(db, fib, "FIB", [dict(parameter_key="IONF_SUP_USED", value=450)])["ok"]
    # limits changed in the same request apply to the same request
    both = upsert(db, fib, "FIB", [dict(parameter_key="IONF_SUP_MAX", value=1000), dict(parameter_key="IONF_SUP_USED", value=950)],
                  role=ADMIN, acknowledge_risk=True)
    assert both["ok"], both
    d = get(db, fib, "FIB", keys=["IONF_SUP_USED"])["definitions"][0]
    assert (d["minimum_value"], d["maximum_value"]) == (100, 1000)                   # resolved bounds are exposed to the UI
    # an unset 0/0 pair means "no limit"
    upsert(db, fib, "FIB", [dict(parameter_key="IONF_SUP_MIN", value=0), dict(parameter_key="IONF_SUP_MAX", value=0)],
           role=ADMIN, acknowledge_risk=True)
    assert upsert(db, fib, "FIB", [dict(parameter_key="IONF_SUP_USED", value=5000)])["ok"]


def test_restore_revision(db, equipment):
    fib = equipment[0]
    h = db.call("fn_list_equipment_calibration_history", dict(equipment_type="FIB", equipment_id=fib))
    rev1 = h[-1]["revision"]
    # rev1 contained only IONF_SUP_USED=612.5 and IONF_WD_DEF=19; everything set later must disappear on restore
    r = db.call("fn_restore_equipment_calibration_revision",
                dict(equipment_id=fib, equipment_type="FIB", revision=rev1, actor_role=ADMIN, acknowledge_risk=True))
    assert r["ok"] and r["changed"] > 0
    b = get(db, fib, "FIB", keys=["IONF_SUP_USED", "IONF_WD_DEF", "IONI_LENS_TYPE", "IONI_MD_INITIALIZED"])
    assert val(b, "IONF_SUP_USED") == 612.5 and val(b, "IONF_WD_DEF") == 19
    assert val(b, "IONI_LENS_TYPE") is None and val(b, "IONI_MD_INITIALIZED") is None
    last = db.call("fn_list_equipment_calibration_history", dict(equipment_type="FIB", equipment_id=fib, limit=1))[0]
    assert last["kind"] == "restore" and last["source_ref"] == f"revision {rev1}"
    assert db.call("fn_restore_equipment_calibration_revision", dict(equipment_id=fib, equipment_type="FIB", revision=9999, actor_role=ADMIN))["error"] == "revision not found"


def test_table_cells(db, equipment):
    fib = equipment[0]
    key = "IONF_AP01_PICO_AMP"
    assert upsert(db, fib, "FIB", [dict(parameter_key=key, value=1.5)], role=DEV)["ok"]
    t = db.call("fn_get_calibration_table", dict(equipment_id=fib, equipment_type="FIB", table_code="FIB_APERTURES"))
    assert t["ok"] and len(t["cells"]) == 234 and len(t["table"]["rows"]) == 13 and len(t["table"]["cols"]) == 18
    cell = next(c for c in t["cells"] if c["row_key"] == "1" and c["col_key"] == "PICO_AMP")
    assert cell["value"] == 1.5 and cell["parameter_key"] == key
    assert db.call("fn_get_calibration_table", dict(equipment_id=fib, equipment_type="FIB", table_code="NOPE"))["ok"] is False


def test_clear_and_notes(db, equipment):
    sem = equipment[1]
    r = upsert(db, sem, "SEM", [dict(parameter_key="IMD_4QUAD_DELAY", value=200, notes="factory", verified=True)], role=DEV)
    assert r["ok"] and r["values"][0]["notes"] == "factory" and r["values"][0]["verified_at"]
    rev = r["result"]["revision"]
    note_only = upsert(db, sem, "SEM", [dict(parameter_key="IMD_4QUAD_DELAY", value=200, notes="rechecked")], role=DEV)
    assert note_only["result"]["changed"] == 0 and note_only["result"]["revision"] == rev and note_only["values"][0]["notes"] == "rechecked"
    cleared = upsert(db, sem, "SEM", [dict(parameter_key="IMD_4QUAD_DELAY", clear=True)], role=DEV)
    assert cleared["result"]["changed"] == 1 and val(get(db, sem, "SEM", keys=["IMD_4QUAD_DELAY"]), "IMD_4QUAD_DELAY") is None


def test_multiple_profiles_one_active(db, equipment):
    fib = equipment[0]
    r = upsert(db, fib, "FIB", [dict(parameter_key="IONF_WD_DEF", value=17)], profile_name="after PM 2026-09")
    assert r["ok"] and r["profile"]["profile_name"] == "after PM 2026-09" and r["profile"]["is_active"] is False
    assert get(db, fib, "FIB", keys=["IONF_WD_DEF"])["profile"]["profile_name"] == "default"                   # default view = active profile
    assert val(get(db, fib, "FIB", keys=["IONF_WD_DEF"], profile_name="after PM 2026-09"), "IONF_WD_DEF") == 17


# ------------------------------------------------------------------------------------------ vendor import
CAL = os.environ.get("CALIBRATION_DOCS_DIR")


@pytest.mark.skipif(not CAL, reason="set CALIBRATION_DOCS_DIR to the folder with icmd.TXT / md.TXT / UI1280reg.txt")
def test_import_vendor_files(db, equipment):
    from calibration_catalog import md_parser, registry_parser
    rows = md_parser.parse_md_file(os.path.join(CAL, "icmd.TXT"), "icmd.TXT")
    items = [dict(kind=r.kind, slot=r.slot, raw=r.raw, symbol=r.symbol) for r in rows]
    eq = equipment[0]
    base = dict(equipment_id=eq, equipment_type="FIB", profile_name="import-test", items=items, file_name="icmd.TXT")
    assert db.call("fn_import_equipment_calibration", {**base, "actor_role": SUPER})["error"] == "forbidden_role"
    prev = db.call("fn_import_equipment_calibration", {**base, "actor_role": DEV, "dry_run": True})
    assert prev["ok"] and prev["dry_run"] and prev["matched"] == 413 and prev["unmatched_count"] == 4            # 4 = the passwords
    assert prev["rejected_count"] == 0 and prev["changed"] == 413 and prev["risky_changed"] > 0
    assert prev["warning_count"] == 1 and prev["warnings"][0]["parameter_key"] == "IONI_DET_USED"                 # vendor doc says 0/1, machine holds 2
    assert db.one("select count(*) from ionbeam_asset.calibration_profile where profile_name='import-test'") == 0    # dry run leaves nothing
    denied = db.call("fn_import_equipment_calibration", {**base, "actor_role": DEV, "dry_run": False})
    assert denied["error"] == "risk_ack_required"
    done = db.call("fn_import_equipment_calibration", {**base, "actor_role": DEV, "dry_run": False, "acknowledge_risk": True, "actor_user_id": 1})
    assert done["ok"] and done["changed"] == 413 and done["revision"] == 1
    again = db.call("fn_import_equipment_calibration", {**base, "actor_role": DEV, "dry_run": False, "acknowledge_risk": True})
    assert again["changed"] == 0                                                                              # idempotent
    b = get(db, eq, "FIB", profile_name="import-test", keys=["IONI_INSTR_NO", "IONF_AP01_L1"])
    assert val(b, "IONI_INSTR_NO") == 940
    # the passwords were never stored anywhere
    snap = db.one("select full_snapshot::text from ionbeam_asset.calibration_revision r join ionbeam_asset.calibration_profile p on p.id=r.profile_id where p.profile_name='import-test' and r.revision=1")
    assert "PSWD" not in snap.upper()

    _, leaves = registry_parser.parse_registry_file(os.path.join(CAL, "UI1280reg.txt"))
    reg_items = [dict(path=lf.full, raw=lf.raw) for lf in leaves if not lf.is_binary]
    r = db.call("fn_import_equipment_calibration", dict(equipment_id=equipment[1], equipment_type="SEM", profile_name="reg", items=reg_items,
                                                        file_name="UI1280reg.txt", actor_role=DEV, dry_run=True))
    assert r["ok"] and r["matched"] == 648 and r["rejected_count"] == 0
    assert r["other_type_count"] == 88                                                                        # the FIB half of the same registry file
    assert r["unmatched_count"] == len(reg_items) - 648 - 88                                                  # user accounts, debug flags, UI prefs ... never stored


@pytest.mark.skipif(not CAL, reason="set CALIBRATION_DOCS_DIR to the folder with icmd.TXT / md.TXT / UI1280reg.txt")
def test_importing_the_wrong_machine_data_file_is_refused(db, equipment):
    from calibration_catalog import md_parser
    rows = md_parser.parse_md_file(os.path.join(CAL, "icmd.TXT"), "icmd.TXT")          # ion-column file ...
    items = [dict(kind=r.kind, slot=r.slot, raw=r.raw, symbol=r.symbol) for r in rows]
    r = db.call("fn_import_equipment_calibration", dict(equipment_id=equipment[1], equipment_type="SEM", items=items,   # ... into a SEM column
                                                        file_name="icmd.TXT", actor_role=DEV, dry_run=True))
    assert r["matched"] < 30 and r["rejected_count"] > 250 and "vendor symbol" in r["rejected"][0]["message"]
    rows = md_parser.parse_md_file(os.path.join(CAL, "md.TXT"), "md.TXT")
    items = [dict(kind=r.kind, slot=r.slot, raw=r.raw, symbol=r.symbol) for r in rows]
    ok = db.call("fn_import_equipment_calibration", dict(equipment_id=equipment[1], equipment_type="SEM", items=items,
                                                         file_name="md.TXT", actor_role=DEV, dry_run=True))
    assert ok["matched"] == 1286 and ok["rejected_count"] == 0 and ok["warning_count"] == 2


def test_import_calibration_csv_rows_by_parameter_key(db, equipment):
    """Rows of a calibration CSV (Export CSV format) are matched by catalog key; the usual checks still apply."""
    eq = equipment[0]
    num = db.one("""select parameter_key from ionbeam_asset.calibration_parameter_definition
                    where equipment_type='FIB' and is_active and value_type='number' and access_level='adjustable'
                      and semantics_known and table_code is null and minimum_value is null and maximum_value is null
                      and limit_min_key is null and limit_max_key is null order by id limit 1""")
    num2 = db.one("""select parameter_key from ionbeam_asset.calibration_parameter_definition
                     where equipment_type='FIB' and is_active and value_type in ('number','integer') and parameter_key <> %s
                     order by id limit 1""", (num,))
    sem_only = db.one("""select parameter_key from ionbeam_asset.calibration_parameter_definition s where s.equipment_type='SEM'
                         and not exists (select 1 from ionbeam_asset.calibration_parameter_definition f
                                         where f.equipment_type='FIB' and f.parameter_key=s.parameter_key) order by id limit 1""")
    items = [dict(parameter_key=num, raw="1.25"), dict(parameter_key=num2, raw="abc"),
             dict(parameter_key="NO_SUCH_KEY", raw="1"), dict(parameter_key=sem_only, raw="1")]
    base = dict(equipment_id=eq, equipment_type="FIB", profile_name="csv-test", items=items, file_name="calibration.csv")
    prev = db.call("fn_import_equipment_calibration", {**base, "actor_role": DEV, "dry_run": True})
    assert prev["ok"] and prev["matched"] == 1 and prev["changed"] == 1
    assert prev["rejected_count"] == 1 and prev["rejected"][0]["parameter_key"] == num2
    assert prev["unmatched_count"] == 1 and prev["unmatched"] == ["NO_SUCH_KEY"]
    assert prev["other_type_count"] == 1                                                                     # a SEM key in a FIB import
    refused = db.call("fn_import_equipment_calibration", {**base, "actor_role": DEV, "dry_run": False})
    assert not refused["ok"] and refused["error"] == "validation_failed" and refused["rejected_count"] == 1
    assert get(db, eq, "FIB", profile_name="csv-test", keys=[num])["values"] == []                          # no partial import
    done = db.call("fn_import_equipment_calibration", {**base, "items": items[:1], "actor_role": DEV, "dry_run": False})
    assert done["ok"] and done["changed"] == 1
    assert val(get(db, eq, "FIB", profile_name="csv-test", keys=[num]), num) == 1.25


def test_schema_files_are_idempotent(db, equipment):
    """The backend re-applies 001 + 003 in every process (ensureAdminSchema); nothing may break or be lost."""
    upsert(db, equipment[0], "FIB", [dict(parameter_key="IONF_WD_DEF", value=23)])
    before = (db.one("select count(*) from ionbeam_asset.calibration_parameter_definition"),
              db.one("select count(*) from ionbeam_asset.calibration_revision"),
              db.one("select count(*) from ionbeam_asset.equipment"))
    for _ in range(2):
        db.cur.execute(open(os.path.join(os.path.dirname(__file__), "..", "..", "Sql", "001_schema.sql"), encoding="utf-8").read())
        db.cur.execute(open(os.path.join(os.path.dirname(__file__), "..", "..", "Sql", "003_calibration_schema.sql"), encoding="utf-8").read())
    db.cur.execute("SET search_path TO iobeam_admin, ionbeam_asset, public")
    after = (db.one("select count(*) from ionbeam_asset.calibration_parameter_definition"),
             db.one("select count(*) from ionbeam_asset.calibration_revision"),
             db.one("select count(*) from ionbeam_asset.equipment"))
    assert before == after
    assert val(get(db, equipment[0], "FIB", keys=["IONF_WD_DEF"]), "IONF_WD_DEF") == 23
