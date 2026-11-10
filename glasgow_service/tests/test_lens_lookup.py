import asyncio
import copy
import hashlib
import json
from pathlib import Path
import pytest
import httpx
from glasgow_service import lens_lookup

ROOT=Path(__file__).resolve().parents[2]
CATALOGUE=ROOT/"GlasgowDataIO/Json/processingPatterns.json"


def table():
    return lens_lookup.load_lens_lookup(CATALOGUE)


def test_import_preserves_every_reference_value_and_notes():
    data=table()
    assert data["source"]["sha256"] == hashlib.sha256((ROOT/"GlasgowDataIO/Calibration/LENS 1 PRELENS.xls").read_bytes()).hexdigest()
    expected=[
        [2000,30,"<10","<1",14,80],[2000,30,20,4,9.5,120],[2000,30,30,11,8.4,150],
        [2000,30,70,70,7.1,250],[2000,30,100,150,6.65,350],[2000,30,150,350,6.35,550],
        [3000,30,250,1000,6.04,800],[3000,30,400,2700,"5.82*",1200],
        [3000,30,600,6600,"5.69*",2700],[3000,30,825,11500,"5.62*",5000],
        [None,10,150,250,3.1,3000],
    ]
    keys=["stepsBetweenApertures","beamVoltageKV","apertureDiameterUM","beamCurrentPA","lens1KV","spotSizeAngstrom"]
    assert [[row[k] for k in keys] for row in data["rows"]] == expected
    assert [row["sourceRow"] for row in data["rows"]] == list(range(2,13))
    assert len(data["notes"]) == 6
    assert data["notes"][-1]["text"] == "SLF + .3 = Lens1 for 2700."


@pytest.mark.parametrize("voltage,current,interpolate,status,size",[
    (30,150,False,"exact",35),(10,250,False,"exact",300),(30,250,False,"unavailable",None),
    (30,250,True,"interpolated",45),(10,150,True,"unavailable",None),
    (30,0.5,True,"unavailable",None),(30,1,True,"unavailable",None),
    (30,20000,True,"unavailable",None),(20,150,True,"unavailable",None),
])
def test_lookup_boundaries_and_voltage_separation(voltage,current,interpolate,status,size):
    result=lens_lookup.lookup_spot_size(table(),voltage,current,interpolate=interpolate)
    assert result["status"] == status and result["spotSizeNM"] == size
    if size is not None:
        assert result["spotSizeUM"] == size/1000
    else:
        assert result["sourceRows"] == []


def test_slf_and_invalid_or_duplicate_data():
    assert lens_lookup.lookup_spot_size(table(),30,2700)["requiresSLF"] is True
    assert lens_lookup.lookup_spot_size(table(),30,150)["sourceRows"] == [6]
    for field,value in [("spotSizeAngstrom",float("nan")),("beamCurrentPA",True),("lens1KV","5.82garbage")]:
        data=table();data["rows"][0][field]=value
        with pytest.raises(ValueError): lens_lookup.validate_lens_lookup(data)
    data=table();data["rows"][1]["beamCurrentPA"]=data["rows"][2]["beamCurrentPA"]
    with pytest.raises(ValueError): lens_lookup.validate_lens_lookup(data)


def test_depth_requires_a_calibrated_rate_and_consistent_units():
    assert lens_lookup.estimate_milling_depth(1000,1,4,2) == {"chargeNC":1,"volumeUM3":2,"depthUM":0.5}
    assert lens_lookup.estimate_milling_depth(0,1,4,2)["depthUM"] == 0
    with pytest.raises(TypeError): lens_lookup.estimate_milling_depth(1000,1,4)
    for args in [(1000,1,0,2),(1000,1,4,0),(1000,-1,4,2),(float("inf"),1,4,2)]:
        with pytest.raises(ValueError): lens_lookup.estimate_milling_depth(*args)


def test_path_precedence_and_missing_selected_deployment(monkeypatch,tmp_path):
    monkeypatch.setenv("PROCESSING_PATTERNS_CONFIG",str(CATALOGUE))
    assert lens_lookup.catalogue_path() == CATALOGUE
    monkeypatch.delenv("PROCESSING_PATTERNS_CONFIG")
    monkeypatch.setattr(lens_lookup,"find_config_path",lambda required=False: tmp_path/"streamData.json")
    assert lens_lookup.catalogue_path() == tmp_path/"processingPatterns.json"
    with pytest.raises(FileNotFoundError): lens_lookup.load_lens_lookup()


def test_reference_api_never_starts_hardware_and_requires_rate(monkeypatch):
    from fastapi import FastAPI
    from glasgow_service import processing_reference_api as api
    monkeypatch.delenv("GLASGOW_TOKEN",raising=False)
    reference=table()
    monkeypatch.setattr(api.lens_lookup,"load_lens_lookup",lambda: reference)
    app=FastAPI()
    app.include_router(api.router)
    async def requests():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://reference.test") as client:
            assert len((await client.get("/processing/lens-lookup")).json()["lensLookup"]["rows"]) == 11
            assert (await client.get("/processing/spot-size",params={"beam_voltage_kv":30,"beam_current_pa":150})).json()["spotSizeNM"] == 35
            assert (await client.get("/processing/spot-size",params={"beam_voltage_kv":10,"beam_current_pa":150})).json()["status"] == "unavailable"
            args={"beam_current_pa":1000,"exposure_time_s":1,"area_um2":4}
            assert (await client.get("/processing/milling-depth",params=args)).status_code == 422
            args["removal_rate_um3_per_nc"]=2
            assert (await client.get("/processing/milling-depth",params=args)).json()["depthUM"] == 0.5
            monkeypatch.setenv("GLASGOW_TOKEN","test-reference-token")
            assert (await client.get("/processing/lens-lookup")).status_code == 401
    asyncio.run(requests())
