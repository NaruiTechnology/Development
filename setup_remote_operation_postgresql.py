#!/usr/bin/env python3
"""Install or update the OperationData schema on local or remote PostgreSQL.

Examples:
  python3 setup_remote_operation_postgresql.py
  python3 setup_remote_operation_postgresql.py --connection-string postgresql://user:pass@host:5432/operation_data?sslmode=require
  python3 setup_remote_operation_postgresql.py --host db.example.com --port 5432 --database operation_data --user app_user --password secret --sslmode require
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

DEVELOPMENT_ROOT = Path(__file__).resolve().parent
AUTOMATION_PY_ROOT = DEVELOPMENT_ROOT / "AutomationPy"
if str(AUTOMATION_PY_ROOT) not in sys.path:
    sys.path.insert(0, str(AUTOMATION_PY_ROOT))

from buildingblocks.decorators_acess_role import requireAdmin  # noqa: E402

import secretstore

DEFAULT_DB_CONFIG = DEVELOPMENT_ROOT / "OperationData" / "Json" / "OperationDataDb.json"
DEFAULT_SCHEMA_FILE = DEVELOPMENT_ROOT / "OperationData" / "Sql" / "001_schema.sql"


def main():
    args = parse_args()
    setup_operation_data_db(args, current_role=args.role)


@requireAdmin
def setup_operation_data_db(args, *, current_role):
    db_defaults = load_db_defaults(args.db_config)
    params = connection_params(args, db_defaults)
    schema_file = Path(args.schema_file or DEFAULT_SCHEMA_FILE)

    if args.ensure_database:
        ensure_database(params, args.admin_database)

    if not args.no_schema:
        run_psql(params, params["database"], ["-v", "ON_ERROR_STOP=1"], schema_file.read_text(encoding="utf-8"))
        print("loaded schema")

    if not args.no_grants:
        role_name = args.grant_role or params["user"]
        run_psql(params, params["database"], ["-v", "ON_ERROR_STOP=1"], role_grant_sql(params["database"], role_name))
        print("ensured role grants for {}".format(role_name))


def parse_args():
    parser = argparse.ArgumentParser(description="Install/update the OperationData PostgreSQL schema.")
    parser.add_argument("--role", default=os.environ.get("IOBEAM_CURRENT_ROLE", "ADMIN"), help="Current access role; requires ADMIN or higher.")
    parser.add_argument("--db-config", default=os.environ.get("IOBEAM_OPERATION_DB_CONFIG", str(DEFAULT_DB_CONFIG)), help="OperationDataDb.json to read DB defaults from.")
    parser.add_argument("--connection-string", help="postgresql://user:pass@host:port/database?sslmode=require")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--database")
    parser.add_argument("--user")
    parser.add_argument("--password")
    parser.add_argument("--sslmode")
    parser.add_argument("--admin-database", default="postgres", help="Database used to create/check the target DB.")
    parser.add_argument("--schema-file")
    parser.add_argument("--grant-role", help="PostgreSQL role to grant schema permissions; defaults to --user.")
    parser.add_argument("--no-grants", action="store_true")
    parser.add_argument("--no-schema", action="store_true")
    parser.add_argument("--no-ensure-database", dest="ensure_database", action="store_false")
    parser.set_defaults(ensure_database=True)
    return parser.parse_args()


def connection_params(args, db_defaults):
    params = {
        "host": first_value(args.host, os.environ.get("IOBEAM_OPERATION_DB_HOST"), db_defaults.get("Host"), "/var/run/postgresql"),
        "port": int(first_value(args.port, os.environ.get("IOBEAM_OPERATION_DB_PORT"), db_defaults.get("Port"), 5432)),
        "database": first_value(args.database, os.environ.get("IOBEAM_OPERATION_DB_NAME"), db_defaults.get("DatabaseName"), "operation_data"),
        "user": first_value(args.user, os.environ.get("IOBEAM_OPERATION_DB_USER"), db_defaults.get("User"), current_login()),
        "password": first_value(args.password, os.environ.get("IOBEAM_OPERATION_DB_PASSWORD"), db_defaults.get("Password")),
        "sslmode": first_value(args.sslmode, os.environ.get("IOBEAM_OPERATION_DB_SSLMODE"), db_defaults.get("SslMode")),
    }
    if not args.connection_string:
        return params

    url = urlparse(args.connection_string)
    if url.scheme not in ("postgres", "postgresql"):
        raise ValueError("connection string must use postgres:// or postgresql://")
    query = parse_qs(url.query)
    params.update({
        "host": url.hostname or params["host"],
        "port": url.port or params["port"],
        "database": unquote(url.path.lstrip("/")) or params["database"],
        "user": unquote(url.username or "") or params["user"],
        "password": unquote(url.password or "") or params["password"],
        "sslmode": query.get("sslmode", [params["sslmode"]])[0],
    })
    return params


def load_db_defaults(config_path):
    if not config_path:
        return {}
    path = Path(config_path).expanduser()
    if not path.is_absolute():
        path = DEVELOPMENT_ROOT / path
    if not path.is_file():
        return {}

    with path.open("r", encoding="utf-8") as f:
        # Credentials are ${VAR} references to the secrets file (see secretstore).
        data = secretstore.expand(json.load(f), strict=False, blank=True)
    return {
        "Host": data.get("Host"),
        "Port": data.get("Port"),
        "DatabaseName": data.get("DatabaseName"),
        "User": data.get("User"),
        "Password": data.get("Password"),
        "SslMode": data.get("SslMode"),
    }


def first_value(*values):
    for value in values:
        if value not in (None, "", [], {}):
            return value
    return None


def ensure_database(params, admin_database):
    sql = "SELECT 1 FROM pg_database WHERE datname = {}".format(sql_literal(params["database"]))
    out = run_psql(params, admin_database, ["-Atqc", sql])
    if out.strip() == "1":
        print("database {} already exists".format(params["database"]))
        return
    run_psql(params, admin_database, ["-v", "ON_ERROR_STOP=1"], "CREATE DATABASE {};".format(quote_ident(params["database"])))
    print("created database {}".format(params["database"]))


def run_psql(params, database, args, stdin=None):
    cmd = [
        "psql",
        "-h", str(params["host"]),
        "-p", str(params["port"]),
        "-U", str(params["user"]),
        "-d", str(database),
    ] + list(args)
    env = os.environ.copy()
    if params.get("password"):
        env["PGPASSWORD"] = str(params["password"])
    if params.get("sslmode"):
        env["PGSSLMODE"] = str(params["sslmode"])
    proc = subprocess.run(
        cmd,
        input=stdin,
        text=True,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "psql exited with code {}".format(proc.returncode))
    return proc.stdout


def role_grant_sql(db_name, role_name):
    db_ident = quote_ident(db_name)
    role_ident = quote_ident(role_name)
    role_literal = sql_literal(role_name)
    return "\n".join([
        "DO $$",
        "BEGIN",
        "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {}) THEN".format(role_literal),
        "    EXECUTE 'CREATE ROLE ' || quote_ident({}) || ' LOGIN';".format(role_literal),
        "  ELSE",
        "    EXECUTE 'ALTER ROLE ' || quote_ident({}) || ' LOGIN';".format(role_literal),
        "  END IF;",
        "END",
        "$$;",
        "GRANT CONNECT ON DATABASE {} TO {};".format(db_ident, role_ident),
        "GRANT USAGE, CREATE ON SCHEMA operation_data TO {};".format(role_ident),
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA operation_data TO {};".format(role_ident),
        "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA operation_data TO {};".format(role_ident),
        "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA operation_data TO {};".format(role_ident),
        "GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA operation_data TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA operation_data GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA operation_data GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA operation_data GRANT EXECUTE ON FUNCTIONS TO {};".format(role_ident),
    ])


def quote_ident(value):
    return '"' + str(value).replace('"', '""') + '"'


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def current_login():
    return os.environ.get("USER") or os.environ.get("LOGNAME") or "postgres"


if __name__ == "__main__":
    main()
