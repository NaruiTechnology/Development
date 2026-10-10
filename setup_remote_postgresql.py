#!/usr/bin/env python3
"""Install or update the Iobeam Admin schema on local or remote PostgreSQL.

Examples:
  python3 setup_remote_postgresql.py --role ADMIN --deploy-config DeployWorkSpace/Development/DistributionDeploy/Json/DistributionDeploy.json
  python3 setup_remote_postgresql.py --role ADMIN --connection-string postgresql://user:pass@host:5432/iobeam_admin?sslmode=require
  python3 setup_remote_postgresql.py --role 3 --host db.example.com --port 5432 --database iobeam_admin --user app_user --password secret --sslmode require
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs

DEVELOPMENT_ROOT = Path(__file__).resolve().parent
AUTOMATION_PY_ROOT = DEVELOPMENT_ROOT / "AutomationPy"
if str(AUTOMATION_PY_ROOT) not in sys.path:
    sys.path.insert(0, str(AUTOMATION_PY_ROOT))

from buildingblocks.decorators_acess_role import requireAdmin  # noqa: E402

import secretstore

DEFAULT_DEPLOY_CONFIG = (
    DEVELOPMENT_ROOT
    / "DeployWorkSpace"
    / "Development"
    / "DistributionDeploy"
    / "Json"
    / "DistributionDeploy.json"
)
DEFAULT_SCHEMA_FILE = DEVELOPMENT_ROOT / "IobeamAdmin" / "Sql" / "001_schema.sql"
DEFAULT_SEED_FILE = DEVELOPMENT_ROOT / "IobeamAdmin" / "Sql" / "002_seed_root_user.sql"



def main():
    args = parse_args()
    setup_iobeam_admin_db(args, current_role=args.role)


@requireAdmin
def setup_iobeam_admin_db(args, *, current_role):
    deploy_defaults = load_deploy_defaults(args.deploy_config)
    params = connection_params(args, deploy_defaults)
    schema_file = Path(args.schema_file or DEFAULT_SCHEMA_FILE)
    seed_file = Path(args.seed_file or DEFAULT_SEED_FILE)
    grant_role = args.grant_role or deploy_defaults.get("grant_role")

    if args.ensure_database:
        if args.backup_file:
            reset_database_from_backup(params, args.admin_database, Path(args.backup_file))
        else:
            ensure_database(params, args.admin_database)

    if not args.backup_file:
        sql_parts = [schema_file.read_text(encoding="utf-8")]
        if not args.no_seed:
            sql_parts.append(seed_file.read_text(encoding="utf-8"))
        run_psql(params, params["database"], ["-v", "ON_ERROR_STOP=1"], "\n".join(sql_parts))
        print("loaded schema{}".format("" if args.no_seed else " and seed data"))

    if not args.no_grants:
        role_name = grant_role or params["user"]
        run_psql(params, params["database"], ["-v", "ON_ERROR_STOP=1"], role_grant_sql(params["database"], role_name))
        print("ensured role grants for {}".format(role_name))


def parse_args():
    parser = argparse.ArgumentParser(description="Install/update Iobeam Admin PostgreSQL schema.")
    parser.add_argument("--role", default=os.environ.get("IOBEAM_CURRENT_ROLE", "ADMIN"), help="Current access role; requires ADMIN or higher.")
    parser.add_argument("--deploy-config", default=os.environ.get("DISTRIBUTION_DEPLOY_CONFIG", str(DEFAULT_DEPLOY_CONFIG)), help="DistributionDeploy.json to read DB defaults and ProductionConfig from.")
    parser.add_argument("--connection-string", help="postgresql://user:pass@host:port/database?sslmode=require")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--database")
    parser.add_argument("--user")
    parser.add_argument("--password")
    parser.add_argument("--sslmode")
    parser.add_argument("--admin-database", default="postgres", help="Database used to create/check the target DB.")
    parser.add_argument("--schema-file")
    parser.add_argument("--seed-file")
    parser.add_argument("--grant-role", help="PostgreSQL role to grant schema permissions; defaults to --user.")
    parser.add_argument("--backup-file", help="Restore this pg_dump SQL file after dropping/recreating the target database.")
    parser.add_argument("--no-seed", action="store_true")
    parser.add_argument("--no-grants", action="store_true")
    parser.add_argument("--no-ensure-database", dest="ensure_database", action="store_false")
    parser.set_defaults(ensure_database=True)
    return parser.parse_args()


def connection_params(args, deploy_defaults):
    params = {
        "host": first_value(args.host, os.environ.get("IOBEAM_ADMIN_DB_HOST"), deploy_defaults.get("host"), "/var/run/postgresql"),
        "port": int(first_value(args.port, os.environ.get("IOBEAM_ADMIN_DB_PORT"), deploy_defaults.get("port"), 5432)),
        "database": first_value(args.database, os.environ.get("IOBEAM_ADMIN_DB_NAME"), deploy_defaults.get("database"), "iobeam_admin"),
        "user": first_value(args.user, os.environ.get("IOBEAM_ADMIN_DB_USER"), deploy_defaults.get("user"), current_login()),
        "password": first_value(args.password, os.environ.get("IOBEAM_ADMIN_DB_PASSWORD"), deploy_defaults.get("password")),
        "sslmode": first_value(args.sslmode, os.environ.get("IOBEAM_ADMIN_DB_SSLMODE"), deploy_defaults.get("sslmode")),
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


def load_deploy_defaults(config_path):
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
    deployment = read_dict(data, "Deployment")
    setup_action = read_action_data(data, "setupIobeamAdminDb")
    if truthy(deployment.get("IsProduction")):
        setup_action = merge_production_config(setup_action)
    else:
        setup_action = dict(setup_action)
        setup_action.pop("ProductionConfig", None)

    return {
        "host": first_value(
            setup_action.get("adminDbHost"),
            setup_action.get("databaseHost"),
            deployment.get("DatabaseHost"),
        ),
        "port": first_value(
            setup_action.get("adminDbPort"),
            setup_action.get("databasePort"),
            deployment.get("DatabasePort"),
        ),
        "database": first_value(
            setup_action.get("adminDbName"),
            setup_action.get("databaseName"),
            deployment.get("DatabaseName"),
        ),
        "user": first_value(
            setup_action.get("adminDbUser"),
            setup_action.get("databaseRole"),
            deployment.get("DatabaseUser"),
        ),
        "password": first_value(
            setup_action.get("adminDbPassword"),
            deployment.get("DatabasePassword"),
        ),
        "sslmode": first_value(
            setup_action.get("adminDbSslMode"),
            deployment.get("DatabaseSslMode"),
        ),
        "grant_role": first_value(
            setup_action.get("grantRole"),
            setup_action.get("databaseRole"),
            deployment.get("DatabaseUser"),
        ),
    }


def read_action_data(data, action_name):
    actions = data.get("Actions", []) if isinstance(data, dict) else []
    for action in actions:
        if isinstance(action, dict) and action_name in action:
            action_config = action.get(action_name, {})
            return read_dict(action_config, "actionData")
    return {}


def read_dict(data, key):
    value = data.get(key) if isinstance(data, dict) else None
    return value if isinstance(value, dict) else {}


def merge_production_config(action_data):
    base = dict(action_data)
    production_config = base.pop("ProductionConfig", {})
    if not isinstance(production_config, dict):
        return base
    for key, value in production_config.items():
        if value in (None, "", [], {}):
            continue
        if isinstance(base.get(key), dict) and isinstance(value, dict):
            nested = dict(base[key])
            nested.update({k: v for k, v in value.items() if v not in (None, "", [], {})})
            base[key] = nested
        else:
            base[key] = value
    return base


def first_value(*values):
    for value in values:
        if value not in (None, "", [], {}):
            return value
    return None


def truthy(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if value is None:
        return False
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def ensure_database(params, admin_database):
    sql = "SELECT 1 FROM pg_database WHERE datname = {}".format(sql_literal(params["database"]))
    out = run_psql(params, admin_database, ["-Atqc", sql])
    if out.strip() == "1":
        print("database {} already exists".format(params["database"]))
        return
    run_psql(params, admin_database, ["-v", "ON_ERROR_STOP=1"], "CREATE DATABASE {};".format(quote_ident(params["database"])))
    print("created database {}".format(params["database"]))


def reset_database_from_backup(params, admin_database, backup_file):
    if not backup_file.is_file():
        raise FileNotFoundError("backup file not found: {}".format(backup_file))
    db_ident = quote_ident(params["database"])
    db_literal = sql_literal(params["database"])
    reset_sql = "\n".join([
        "SELECT pg_terminate_backend(pid)",
        "  FROM pg_stat_activity",
        " WHERE datname = {}",
        "   AND pid <> pg_backend_pid();",
        "DROP DATABASE IF EXISTS {};",
        "CREATE DATABASE {};",
    ]).format(db_literal, db_ident, db_ident)
    run_psql(params, admin_database, ["-v", "ON_ERROR_STOP=1"], reset_sql)
    run_psql(params, params["database"], ["-v", "ON_ERROR_STOP=1", "-f", str(backup_file)])
    print("restored database {} from {}".format(params["database"], backup_file))


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
        "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA iobeam_admin TO {};".format(role_ident),
        "GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA iobeam_admin TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT EXECUTE ON FUNCTIONS TO {};".format(role_ident),
        "GRANT USAGE, CREATE ON SCHEMA ionbeam_asset TO {};".format(role_ident),
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ionbeam_asset TO {};".format(role_ident),
        "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ionbeam_asset TO {};".format(role_ident),
        "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ionbeam_asset TO {};".format(role_ident),
        "GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA ionbeam_asset TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA ionbeam_asset GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA ionbeam_asset GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {};".format(role_ident),
        "ALTER DEFAULT PRIVILEGES IN SCHEMA ionbeam_asset GRANT EXECUTE ON FUNCTIONS TO {};".format(role_ident),
    ])


def quote_ident(value):
    return '"' + str(value).replace('"', '""') + '"'


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def current_login():
    return os.environ.get("USER") or os.environ.get("LOGNAME") or "postgres"


if __name__ == "__main__":
    main()
