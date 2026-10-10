"""Tests for the shared credential resolver (python3 -m pytest secretstore/tests)."""
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

DEVELOPMENT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(DEVELOPMENT))

import secretstore  # noqa: E402
from secretstore import SecretError  # noqa: E402

CASES = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))


@pytest.fixture
def secrets_file(tmp_path, monkeypatch):
    path = tmp_path / "cfg" / "iobeam" / "secrets.env"
    monkeypatch.setenv("IOBEAM_SECRETS_FILE", str(path))
    for name in [n for n in os.environ if n.startswith(("IOBEAM_", "T_", "X"))]:
        if name != "IOBEAM_SECRETS_FILE":
            monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("MISSING", raising=False)
    return path


# -- shared cases (the TypeScript implementation runs the same file) ---------
@pytest.mark.parametrize("case", CASES["parse"])
def test_parse_cases(case):
    assert secretstore.parse_env(case["text"]) == case["values"]


@pytest.mark.parametrize("text", CASES["parse_errors"])
def test_parse_errors(text):
    with pytest.raises(SecretError):
        secretstore.parse_env(text)


@pytest.mark.parametrize("value", CASES["roundtrip"])
def test_written_values_read_back_identically(secrets_file, value):
    secretstore.write({"V": value})
    assert secretstore.read_file()["V"] == value


@pytest.mark.parametrize("case", CASES["expand"])
def test_expand_cases(secrets_file, monkeypatch, case):
    for name, value in case["env"].items():
        monkeypatch.setenv(name, value)
    assert secretstore.expand(case["input"]) == case["output"]


def test_bash_sources_the_file_to_the_same_values(secrets_file):
    values = {"V{}".format(i): value for i, value in enumerate(CASES["roundtrip"])}
    secretstore.write(values)
    script = "set -a; . {}; set +a; ".format(secrets_file) + "; ".join(
        'printf "%s\\0" "${}"'.format(name) for name in values)
    output = subprocess.run(["bash", "-c", script], capture_output=True, check=True).stdout
    assert output.decode("utf-8").split("\0")[:-1] == list(values.values())


# -- resolution order ------------------------------------------------------
def test_environment_beats_file_reference_beats_secrets_file(secrets_file, tmp_path, monkeypatch):
    secretstore.write({"T_PW": "from-file"})
    assert secretstore.get("T_PW") == "from-file"
    credential = tmp_path / "credential"
    credential.write_text("from-credential\n")
    monkeypatch.setenv("T_PW_FILE", str(credential))
    assert secretstore.get("T_PW") == "from-credential"
    monkeypatch.setenv("T_PW", "from-env")
    assert secretstore.get("T_PW") == "from-env"


def test_strict_error_names_the_variable_never_a_value(secrets_file):
    secretstore.write({"T_OTHER": "do-not-print"})
    with pytest.raises(SecretError) as error:
        secretstore.expand({"a": ["${T_REQUIRED}"]}, source="x.json")
    assert "T_REQUIRED" in str(error.value) and "x.json" in str(error.value)
    assert "do-not-print" not in str(error.value)


def test_lenient_modes(secrets_file):
    assert secretstore.expand("${T_NONE}", strict=False) == "${T_NONE}"
    assert secretstore.expand("${T_NONE}", strict=False, blank=True) == ""
    assert secretstore.missing({"a": "${T_NONE}", "b": "${T_OPT:-}"}) == ["T_NONE"]


# -- file safety -----------------------------------------------------------
def test_permissions_and_comment_preservation(secrets_file):
    secretstore.write({"A": "1"})
    with open(secrets_file, "a", encoding="utf-8") as handle:
        handle.write("# operator note\n")
    secretstore.write({"B": "2"})
    secretstore.write({"A": "changed"})
    secretstore.write({"A": "ignored"}, overwrite=False)
    text = secrets_file.read_text()
    assert "# operator note" in text
    assert secretstore.read_file() == {"A": "changed", "B": "2"}
    assert stat.S_IMODE(secrets_file.stat().st_mode) == 0o600
    assert stat.S_IMODE(secrets_file.parent.stat().st_mode) == 0o700


def test_group_or_world_readable_file_is_refused(secrets_file):
    secretstore.write({"A": "1"})
    secrets_file.chmod(0o640)
    with pytest.raises(SecretError, match="chmod 600"):
        secretstore.read_file()


def test_newlines_are_rejected(secrets_file):
    with pytest.raises(SecretError):
        secretstore.write({"A": "line1\nline2"})


def test_default_location_is_outside_any_checkout(monkeypatch, tmp_path):
    monkeypatch.delenv("IOBEAM_SECRETS_FILE", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert secretstore.default_secrets_path() == str(tmp_path / "iobeam" / "secrets.env")


# -- migration ---------------------------------------------------------------
def old_tree(root):
    ftp = {"enabled": True, "host": "203.0.113.5", "username": "ftp-user",
           "password": "ftp-pass", "folder": "/upload"}
    files = {
        "GlasgowDataIO/Json/streamData.json": {"Actions": [{"streamData": {"actionData": {"ftp": ftp}}}]},
        "IobeamAdmin/Json/IobeamAdmin.json": {"Database": {
            "Host": "203.0.113.9", "User": "cfg-user", "Password": "cfg-pass",
            "ConnectionString": "postgresql://cfg-user:cfg-pass@203.0.113.9/db"}},
        "IobeamAdmin/Json/IobeamAdminDb.json": {"Host": "localhost", "User": "app", "Password": "app-pass"},
    }
    for relative, data in files.items():
        (root / relative).parent.mkdir(parents=True, exist_ok=True)
        (root / relative).write_text(json.dumps(data))
    env = root / "ionbeam-web/backend/.env"
    env.parent.mkdir(parents=True)
    env.write_text("PORT=4000\nGLASGOW_TOKEN=tok\nIOBEAM_ADMIN_DB_PASSWORD=from-env-file\n")


def test_harvest_maps_every_credential_to_its_variable(tmp_path):
    old_tree(tmp_path)
    found = secretstore.harvest(str(tmp_path))
    assert found == {
        "IOBEAM_FTP_HOST": "203.0.113.5", "IOBEAM_FTP_USER": "ftp-user", "IOBEAM_FTP_PASSWORD": "ftp-pass",
        "IOBEAM_ADMIN_CONFIG_DB_HOST": "203.0.113.9", "IOBEAM_ADMIN_CONFIG_DB_USER": "cfg-user",
        "IOBEAM_ADMIN_CONFIG_DB_PASSWORD": "cfg-pass",
        "IOBEAM_ADMIN_DB_HOST": "localhost", "IOBEAM_ADMIN_DB_USER": "app",
        "IOBEAM_ADMIN_DB_PASSWORD": "app-pass",  # the JSON wins over the old .env
        "GLASGOW_TOKEN": "tok",
    }


def test_extract_literals_leaves_only_placeholders():
    data = {"Database": {"Host": "h", "User": "u", "Password": "p",
                         "ConnectionString": "postgresql://u:p@h/db", "Port": 5432}}
    clean, found = secretstore.extract_literals(data, "IobeamAdmin/Json/IobeamAdmin.json")
    assert clean["Database"] == {"Host": "${IOBEAM_ADMIN_CONFIG_DB_HOST}",
                                 "User": "${IOBEAM_ADMIN_CONFIG_DB_USER}",
                                 "Password": "${IOBEAM_ADMIN_CONFIG_DB_PASSWORD}",
                                 "ConnectionString": "${IOBEAM_ADMIN_CONFIG_DB_URL:-}", "Port": 5432}
    assert secretstore.scan_json(clean) == []
    assert found["IOBEAM_ADMIN_CONFIG_DB_PASSWORD"] == "p"


def run_cli(*args, stdin=""):
    return subprocess.run([sys.executable, "-m", "secretstore", *args], cwd=DEVELOPMENT,
                          input=stdin, capture_output=True, text=True)


def test_cli_harvest_from_an_older_installation(tmp_path, secrets_file):
    old_tree(tmp_path)
    result = run_cli("harvest", "--root", str(tmp_path))
    assert result.returncode == 0, result.stderr
    assert "ftp-pass" not in result.stdout  # values are masked
    assert secretstore.read_file()["IOBEAM_FTP_PASSWORD"] == "ftp-pass"


def test_cli_init_from_prepared_file_needs_no_questions(tmp_path, secrets_file):
    seed = tmp_path / "prepared.env"
    seed.write_text("IOBEAM_ADMIN_CONFIG_DB_HOST=db.example\nIOBEAM_ADMIN_CONFIG_DB_USER=app\n"
                    "IOBEAM_ADMIN_CONFIG_DB_PASSWORD='s3cret value'\nIOBEAM_FTP_PASSWORD=\n")
    result = run_cli("init", "--from", str(seed))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "s3cret" not in result.stdout + result.stderr
    values = secretstore.read_file()
    assert values["IOBEAM_ADMIN_CONFIG_DB_PASSWORD"] == "s3cret value"
    assert len(values["GLASGOW_TOKEN"]) == 64           # generated
    assert values["IOBEAM_ADMIN_DB_PASSWORD"]            # generated
    assert "IOBEAM_FTP_PASSWORD" not in values           # empty seed lines are ignored
    # Re-running keeps generated values.
    token = values["GLASGOW_TOKEN"]
    assert run_cli("init", "--no-prompt").returncode == 0
    assert secretstore.read_file()["GLASGOW_TOKEN"] == token


def test_cli_init_needs_nothing_and_reports_what_is_unset(secrets_file):
    result = run_cli("init", "--no-prompt")
    assert result.returncode == 0, result.stderr
    values = secretstore.read_file()
    assert len(values["GLASGOW_TOKEN"]) == 64 and values["IOBEAM_ADMIN_DB_PASSWORD"]
    check = run_cli("check")
    assert "not set (optional) IOBEAM_ADMIN_CONFIG_DB_HOST" in check.stdout
    assert "not set (optional) IOBEAM_FTP_PASSWORD" in check.stdout


def previous_release_handoff(tmp_path, as_zip=True):
    """A DeployWorkspace handoff as releases before the secrets file built it."""
    import io
    import zipfile
    ftp = {"enabled": True, "host": "198.51.100.20", "username": "ftp-real",
           "password": "ftp-real-pass", "folder": "/upload"}
    dummy = dict(ftp, host="localhost", username="vboxuser", password="test-only")
    dist = {
        "Development/GlasgowDataIO/Json/streamData.json":
            {"Actions": [{"streamData": {"actionData": {"ftp": ftp}}}]},
        "Development/GlasgowDataIO/Json/streamData_default.json":
            {"Actions": [{"streamData": {"actionData": {"ftp": dummy}}}]},
        "Development/IobeamAdmin/Json/IobeamAdmin.json":
            {"Database": {"Host": "198.51.100.30", "User": "cfg-real", "Password": "cfg-real-pass"}},
    }
    manifest = {"Deployment": {"DatabaseHost": "198.51.100.30", "DatabaseUser": "cfg-real",
                               "DatabasePassword": "cfg-real-pass"},
                "Actions": [{"exportEnv": {"actionData": {"exports": {
                    "GLASGOW_TOKEN": {"value": "old-release-token", "resolve": False}}}}}]}
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        for name, data in dist.items():
            z.writestr(name, json.dumps(data))
    base = "DeployWorkSpace/Development/DistributionDeploy/"
    if as_zip:
        path = tmp_path / "DeployWorkspace_v0.9_010126_0900.zip"
        with zipfile.ZipFile(path, "w") as z:
            z.writestr(base + "Json/DistributionDeploy.json", json.dumps(manifest))
            z.writestr(base + "dist_app.zip", inner.getvalue())
        return path
    root = tmp_path / "DeployWorkspace_v0.9_010126_0900"
    (root / base / "Json").mkdir(parents=True)
    (root / base / "Json/DistributionDeploy.json").write_text(json.dumps(manifest))
    (root / base / "dist_app.zip").write_bytes(inner.getvalue())
    return root


@pytest.mark.parametrize("as_zip", [True, False])
def test_harvest_previous_release_handoff(tmp_path, as_zip):
    found = secretstore.harvest_handoff(str(previous_release_handoff(tmp_path, as_zip)))
    assert found == {
        "IOBEAM_ADMIN_CONFIG_DB_HOST": "198.51.100.30", "IOBEAM_ADMIN_CONFIG_DB_USER": "cfg-real",
        "IOBEAM_ADMIN_CONFIG_DB_PASSWORD": "cfg-real-pass", "GLASGOW_TOKEN": "old-release-token",
        "IOBEAM_FTP_HOST": "198.51.100.20", "IOBEAM_FTP_USER": "ftp-real", "IOBEAM_FTP_PASSWORD": "ftp-real-pass",
    }


def test_backups_and_test_fixtures_are_never_harvested(tmp_path):
    root = tmp_path / "Development"
    (root / "GlasgowDataIO/Json").mkdir(parents=True)
    dummy = {"enabled": True, "host": "localhost", "username": "vboxuser", "password": "test-only", "folder": "/x"}
    for name in ("streamData_default.json", "streamData unit_test.json"):
        (root / "GlasgowDataIO/Json" / name).write_text(
            json.dumps({"Actions": [{"streamData": {"actionData": {"ftp": dummy}}}]}))
    assert secretstore.harvest(str(root)) == {}


def test_assignments_read_shell_rc_lines():
    text = ("# --- DistributionDeploy exports ---\nexport GLASGOW_CONFIG=/x\n"
            "export GLASGOW_TOKEN=first\nexport GLASGOW_TOKEN='second'\n"
            "SMTP_PASSWORD=\"mail pass\"\nexport TWILIO_AUTH_TOKEN=$FROM_ELSEWHERE\n")
    assert secretstore.assignments(text) == {"GLASGOW_TOKEN": "second", "SMTP_PASSWORD": "mail pass"}


def test_find_handoffs_newest_first(tmp_path):
    import time
    old = tmp_path / "DeployWorkspace_a.zip"
    old.write_bytes(b"")
    time.sleep(0.01)
    new = tmp_path / "DeployWorkspace_b"
    new.mkdir()
    (tmp_path / "unrelated").mkdir()
    assert secretstore.find_handoffs([str(tmp_path)]) == [str(new), str(old)]


def test_provision_order_and_prompt(secrets_file):
    secretstore.write({"IOBEAM_FTP_USER": "kept", "IOBEAM_FTP_HOST": "old-host"})
    asked = []

    def ask(variable):
        asked.append(variable["name"])
        return {"IOBEAM_ADMIN_CONFIG_DB_PASSWORD": "typed"}.get(variable["name"], "")

    result = secretstore.provision(
        seed={"IOBEAM_FTP_HOST": "seed-host"},
        harvested={"IOBEAM_ADMIN_CONFIG_DB_HOST": "harvested-host", "SMTP_PASSWORD": "smtp"},
        environ={"IOBEAM_ADMIN_CONFIG_DB_USER": "env-user"}, ask=ask)
    values = secretstore.read_file()
    assert values["IOBEAM_FTP_HOST"] == "seed-host"            # seed replaces stored
    assert values["IOBEAM_FTP_USER"] == "kept"                 # stored kept
    assert values["IOBEAM_ADMIN_CONFIG_DB_USER"] == "env-user"
    assert values["IOBEAM_ADMIN_CONFIG_DB_HOST"] == "harvested-host"
    assert values["IOBEAM_ADMIN_CONFIG_DB_PASSWORD"] == "typed"
    assert values["SMTP_PASSWORD"] == "smtp"                   # extras carried over
    assert "GLASGOW_TOKEN" not in asked and "IOBEAM_FTP_USER" not in asked
    assert result.missing == []


# -- repository guard --------------------------------------------------------
def test_repository_contains_no_literal_credentials():
    assert secretstore.scan_tree(str(DEVELOPMENT)) == []


def test_scanner_catches_the_patterns_this_repository_had():
    leaked = {"ftp": {"host": "198.51.100.1", "username": "deploy", "password": "x1"},
              "Deployment": {"DatabasePassword": "x2", "DatabaseUser": "deploy"},
              "url": "postgresql://deploy:x3@198.51.100.1:5432/db",
              "exports": {"GLASGOW_TOKEN": {"value": "abcdef0123", "resolve": False}}}
    problems = secretstore.scan_json(leaked)
    assert len(problems) == 6, problems
    assert secretstore.scan_text("Environment=GLASGOW_TOKEN=abcdef0123\n")
    assert not secretstore.scan_text("SBC_VACUUM_TOKEN=change-me\nGLASGOW_TOKEN=\n")
