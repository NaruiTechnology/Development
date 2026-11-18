"""Equipment recipe access through the Node API that owns the configured PostgreSQL connection.

Glasgow remains a lattice executor. This read path shares the exact equipment recipes
used by the browser without copying database secrets or falling back to local JSON.
"""
import os
import re
import httpx

class RecipeUnavailable(Exception):
    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status

async def load_pattern_recipes(equipment_id: int, pattern_key: str, *, client=None):
    if isinstance(equipment_id, bool) or not isinstance(equipment_id, int) or equipment_id <= 0:
        raise ValueError("equipment_id must be a positive integer")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,99}", pattern_key):
        raise ValueError("Invalid pattern key")
    base = os.environ.get("IONBEAM_RECIPE_API_URL", "http://127.0.0.1:4000").rstrip("/")
    url = f"{base}/api/processing/recipes/{equipment_id}/{pattern_key}"
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=60, trust_env=False) as owned:
                response = await owned.get(url)
        else:
            response = await client.get(url)
        if response.status_code == 404:
            raise RecipeUnavailable("No recipes assigned to this equipment and pattern", 404)
        response.raise_for_status()
        result = response.json()
        if result.get("ok") is not True or not isinstance(result.get("collections"), dict):
            raise ValueError("Malformed equipment recipe response")
        return {"ok": True, "equipment_id": equipment_id, "pattern_key": pattern_key, "collections": result["collections"]}
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise RecipeUnavailable("Equipment recipe database API is unavailable") from exc
