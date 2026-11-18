import asyncio
import httpx
import pytest
from fastapi import FastAPI
from glasgow_service import pattern_recipes, processing_reference_api

NAMES = ["28nm", "14nm", "7nm", "5nm", "2nm", "1nm"]

def test_service_reads_database_nodes_without_local_json(monkeypatch):
    monkeypatch.setenv("IONBEAM_RECIPE_API_URL", "http://node.test")
    async def run():
        def reply(request):
            assert request.url.path == "/api/processing/recipes/1289/stairCut"
            return httpx.Response(200, json={"ok": True, "collections": {"SMProcess": {"nodes": [{"name": n} for n in NAMES]}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(reply)) as client:
            result = await pattern_recipes.load_pattern_recipes(1289, "stairCut", client=client)
        assert [n["name"] for n in result["collections"]["SMProcess"]["nodes"]] == NAMES
    asyncio.run(run())

@pytest.mark.parametrize("status", [404, 500])
def test_service_does_not_fall_back_when_database_api_fails(status):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(status))) as client:
            with pytest.raises(pattern_recipes.RecipeUnavailable) as error:
                await pattern_recipes.load_pattern_recipes(1289, "stairCut", client=client)
            assert error.value.status == (404 if status == 404 else 503)
    asyncio.run(run())

def test_service_recipe_route_auth_and_equipment_identity(monkeypatch):
    async def lookup(equipment_id, pattern_key):
        return {"ok": True, "equipment_id": equipment_id, "pattern_key": pattern_key, "collections": {}}
    monkeypatch.setattr(pattern_recipes, "load_pattern_recipes", lookup)
    monkeypatch.setenv("GLASGOW_TOKEN", "recipe-test")
    app=FastAPI(); app.include_router(processing_reference_api.router)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://service.test") as client:
            assert (await client.get("/processing/recipes/1289/stairCut")).status_code == 401
            response=await client.get("/processing/recipes/1289/stairCut", headers={"Authorization":"Bearer recipe-test"})
            assert response.status_code == 200 and response.json()["equipment_id"] == 1289
            assert (await client.get("/processing/recipes/0/stairCut",headers={"Authorization":"Bearer recipe-test"})).status_code == 422
    asyncio.run(run())
