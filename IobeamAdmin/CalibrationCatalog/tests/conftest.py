"""Fixtures: a throw-away real PostgreSQL 16 (pip install pgserver psycopg2-binary pytest) with the project's own
001_schema.sql + 003_calibration_schema.sql + 004_calibration_seed.sql loaded - the same order the backend uses."""
import json, os, sys, tempfile
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SQL = os.path.join(HERE, "..", "..", "Sql")
sys.path.insert(0, os.path.join(HERE, ".."))


def _read(name):
    with open(os.path.join(SQL, name), encoding="utf-8") as fh:
        return fh.read()


@pytest.fixture(scope="session")
def pg():
    pgserver = pytest.importorskip("pgserver", reason="calibration SQL tests need pgserver")
    psycopg2 = pytest.importorskip("psycopg2", reason="calibration SQL tests need psycopg2-binary")
    d = tempfile.mkdtemp(prefix="calibpg_")
    srv = pgserver.get_server(d)
    conn = psycopg2.connect(srv.get_uri())
    conn.autocommit = True
    cur = conn.cursor()
    for f in ("001_schema.sql", "003_calibration_schema.sql", "004_calibration_seed.sql"):
        cur.execute(_read(f))
    yield conn
    conn.close()
    srv.cleanup()


class Db:
    """Calls the stored functions exactly like the Node backend does (search_path + jsonb payload)."""
    def __init__(self, conn):
        self.conn = conn
        self.cur = conn.cursor()
        self.cur.execute("SET search_path TO iobeam_admin, ionbeam_asset, public")

    def call(self, fn, payload):
        self.cur.execute(f"SELECT {fn}(%s::jsonb)", (json.dumps(payload),))
        return self.cur.fetchone()[0]

    def one(self, sql, args=None):
        self.cur.execute(sql, args)
        return self.cur.fetchone()[0]


@pytest.fixture()
def db(pg):
    return Db(pg)


@pytest.fixture(scope="session")
def equipment(pg):
    """(fib_equipment_id, sem_equipment_id) - two registered machines from the project's own equipment registry."""
    cur = pg.cursor()
    cur.execute("SELECT id FROM ionbeam_asset.equipment ORDER BY id LIMIT 2")
    a, b = [r[0] for r in cur.fetchall()]
    return a, b
