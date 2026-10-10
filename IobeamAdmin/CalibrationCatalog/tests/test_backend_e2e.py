"""Runs ionbeam-web/backend/tests/calibrationApi.e2e.ts (Express routes -> repository -> psql -> PostgreSQL) against a
throw-away PostgreSQL. Needs node >= 20 and the backend's node_modules (npm install in ionbeam-web/backend)."""
import json, os, re, shutil, subprocess, tempfile
import pytest

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "ionbeam-web", "backend"))
TSX = os.path.join(BACKEND, "node_modules", ".bin", "tsx")


@pytest.mark.skipif(not os.path.exists(TSX) or not shutil.which("node"), reason="needs node and ionbeam-web/backend/node_modules")
def test_calibration_api_end_to_end():
    pgserver = pytest.importorskip("pgserver", reason="calibration API tests need pgserver")
    psycopg2 = pytest.importorskip("psycopg2", reason="calibration API tests need psycopg2-binary")
    bin_dir = os.path.join(os.path.dirname(pgserver.__file__), "pginstall", "bin")     # provides the psql the backend shells out to
    d = tempfile.mkdtemp(prefix="calibpg_")
    srv = pgserver.get_server(d)
    try:
        uri = srv.get_uri()
        conn = psycopg2.connect(uri)
        conn.autocommit = True
        conn.cursor().execute("CREATE DATABASE iobeam_admin")
        cfg = os.path.join(d, "IobeamAdmin.json")
        json.dump({"Header": {"Application": "e2e"}, "Users": [], "Equipment": [],
                   "Database": {"Host": re.search(r"host=([^&]+)", uri).group(1), "Port": 5432, "User": "postgres", "Password": "",
                                "DatabaseName": "iobeam_admin", "SslMode": "", "CommandTimeoutMs": 60000}}, open(cfg, "w"))
        env = dict(os.environ, PATH=bin_dir + os.pathsep + os.environ["PATH"], IOBEAM_ADMIN_CONFIG=cfg, CALIBRATION_E2E="1")
        r = subprocess.run([TSX, "tests/calibrationApi.e2e.ts"], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=300)
        assert r.returncode == 0, r.stdout + r.stderr
        assert "all checks passed" in r.stdout
    finally:
        srv.cleanup()
