#!/usr/bin/env python3
"""Install or update the Iobeam Admin schema on local or remote PostgreSQL.

Examples:
  python3 setup_remote_postgresql.py --role ADMIN --connection-string postgresql://user:pass@host:5432/iobeam_admin?sslmode=require
  python3 setup_remote_postgresql.py --role 3 --host db.example.com --port 5432 --database iobeam_admin --user app_user --password secret --sslmode require
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs
from AutomationPy.buildingblocks.decorators_acess_role import requireAdmin  # noqa: E402

DEVELOPMENT_ROOT = Path(__file__).resolve().parents[1]
AUTOMATION_PY_ROOT = DEVELOPMENT_ROOT / "AutomationPy"
if str(AUTOMATION_PY_ROOT) not in sys.path:
    sys.path.insert(0, str(AUTOMATION_PY_ROOT))




def main():
    args = parse_args()
    setup_iobeam_admin_db(args, current_role=args.role)


@requireAdmin
def setup_iobeam_admin_db(args, *, current_role):
    params = connection_params(args)
    schema_file = Path(args.schema_file or Path(__file__).with_name("Sql") / "001_schema.sql")
    seed_file = Path(args.seed_file or Path(__file__).with_name("Sql") / "002_seed_root_user.sql")

    if args.ensure_database:
        ensure_database(params, args.admin_database)

    sql_parts = [schema_file.read_text(encoding="utf-8")]
    if not args.no_seed:
        sql_parts.append(seed_file.read_text(encoding="utf-8"))
    run_psql(params, params["database"], ["-v", "ON_ERROR_STOP=1"], "\n".join(sql_parts))
    print("loaded schema{}".format("" if args.no_seed else " and seed data"))

    if not args.no_grants:
        role_name = args.grant_role or params["user"]
        run_psql(params, params["database"], ["-v", "ON_ERROR_STOP=1"], role_grant_sql(params["database"], role_name))
        print("ensured role grants for {}".format(role_name))


def parse_args():
    parser = argparse.ArgumentParser(description="Install/update Iobeam Admin PostgreSQL schema.")
    parser.add_argument("--role", default=os.environ.get("IOBEAM_CURRENT_ROLE", "ADMIN"), help="Current access role; requires ADMIN or higher.")
    parser.add_argument("--connection-string", help="postgresql://user:pass@host:port/database?sslmode=require")
    parser.add_argument("--host", default=os.environ.get("IOBEAM_ADMIN_DB_HOST", "/var/run/postgresql"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("IOBEAM_ADMIN_DB_PORT", "5432")))
    parser.add_argument("--database", default=os.environ.get("IOBEAM_ADMIN_DB_NAME", "iobeam_admin"))
    parser.add_argument("--user", default=os.environ.get("IOBEAM_ADMIN_DB_USER") or current_login())
    parser.add_argument("--password", default=os.environ.get("IOBEAM_ADMIN_DB_PASSWORD"))
    parser.add_argument("--sslmode", default=os.environ.get("IOBEAM_ADMIN_DB_SSLMODE"))
    parser.add_argument("--admin-database", default="postgres", help="Database used to create/check the target DB.")
    parser.add_argument("--schema-file")
    parser.add_argument("--seed-file")
    parser.add_argument("--grant-role", help="PostgreSQL role to grant schema permissions; defaults to --user.")
    parser.add_argument("--no-seed", action="store_true")
    parser.add_argument("--no-grants", action="store_true")
    parser.add_argument("--no-ensure-database", dest="ensure_database", action="store_false")
    parser.set_defaults(ensure_database=True)
    return parser.parse_args()


def connection_params(args):
    params = {
        "host": args.host,
        "port": args.port,
        "database": args.database,
        "user": args.user,
        "password": args.password,
        "sslmode": args.sslmode,
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
        "GRANT USAGE, CREATE ON SCHEMA public TO {};".format(role_ident),
        "GRANT USAGE, CREATE ON SCHEMA iobeam_admin TO {};".format(role_ident),
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA iobeam_admin TO {};".format(role_ident),
        "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA iobeam_admin TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {};".format(role_ident),
    ])


def quote_ident(value):
    return '"' + str(value).replace('"', '""') + '"'


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def current_login():
    return os.environ.get("USER") or os.environ.get("LOGNAME") or "postgres"


if __name__ == "__main__":
    main()
