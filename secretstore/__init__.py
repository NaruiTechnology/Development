"""Runtime secret resolution for Iobeam / Operations configuration files.

Credentials (FTP, PostgreSQL, bearer tokens, SMTP, ...) are never stored in
tracked JSON. A JSON value references a variable instead::

    "password": "${IOBEAM_FTP_PASSWORD}"          required
    "SslMode":  "${IOBEAM_ADMIN_DB_SSLMODE:-}"    optional, default ""
    "Host":     "${IOBEAM_ADMIN_DB_HOST:-localhost}"

A variable resolves, in order, from

1. the process environment (``NAME``),
2. a file named by ``NAME_FILE`` (Docker / systemd credentials),
3. the secrets file: ``$IOBEAM_SECRETS_FILE`` or
   ``$XDG_CONFIG_HOME/iobeam/secrets.env`` (default ``~/.config/iobeam/secrets.env``).

The secrets file lives in the service account's home, outside the git
checkout, outside dist_app.zip and outside the deploy root (which the deploy
workflow deletes and recreates). Its format is the systemd
``EnvironmentFile=`` format, so the same file is also handed to the systemd
units: ``KEY=value`` lines, ``#`` comment lines, optional single or double
quotes, no ``export`` and no inline comments.

This module is stdlib-only and Python 3.8 compatible because the deploy
workflow vendors it and runs it with the target host's system interpreter.
The Node backend implements the same rules in
``ionbeam-web/backend/src/secretStore.ts``; ``tests/test_secretstore.py``
checks both against one shared fixture.
"""

from __future__ import annotations

import getpass
import io
import json
import os
import re
import secrets as _random
import stat
import sys
import tempfile
import threading
import zipfile
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

ENV_SECRETS_FILE = "IOBEAM_SECRETS_FILE"
PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
_FULL_PLACEHOLDER = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$")
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_LINE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

_lock = threading.Lock()
_cache: Dict[str, Tuple[float, Dict[str, str]]] = {}


class SecretError(RuntimeError):
    """A referenced secret is missing, or the secrets file is unsafe/invalid."""


# --------------------------------------------------------------------------
# Where credentials live in tracked configuration files.
#
# (repo-relative file, key path inside the JSON, variable name). Used to
# build placeholder templates, to harvest literal values from an existing
# installation during upgrade, to move values typed into the settings UI
# into the secrets file, and by the build gate.
# --------------------------------------------------------------------------
_FTP = ("Actions", 0, "streamData", "actionData", "ftp")
_STREAM_FILES = (
    "GlasgowDataIO/Json/streamData.json",
    "GlasgowDataIO/Json/streamData_default.json",
    "GlasgowDataIO/Json/streamData unit_test.json",
)
SECRET_BINDINGS: List[Tuple[str, Tuple[Any, ...], str]] = []
for _file in _STREAM_FILES:
    SECRET_BINDINGS += [
        (_file, _FTP + ("host",), "IOBEAM_FTP_HOST"),
        (_file, _FTP + ("username",), "IOBEAM_FTP_USER"),
        (_file, _FTP + ("password",), "IOBEAM_FTP_PASSWORD"),
    ]
# Harvest order matters: the first literal found for a variable wins.
#
# Two different admin-database accounts exist on a deployed host:
#   IOBEAM_ADMIN_CONFIG_DB_*  IobeamAdmin.json "Database": the connection the
#                             app actually queries (Settings -> Database tab).
#   IOBEAM_ADMIN_DB_*         IobeamAdminDb.json: the local runtime role that
#                             setupIobeamAdminDb provisions; the backend's
#                             fallback (its existing env variable names).
_MANIFEST = "DeployWorkSpace/Development/DistributionDeploy/Json/DistributionDeploy.json"
SECRET_BINDINGS += [
    ("IobeamAdmin/Json/IobeamAdmin.json", ("Database", "Host"), "IOBEAM_ADMIN_CONFIG_DB_HOST"),
    ("IobeamAdmin/Json/IobeamAdmin.json", ("Database", "User"), "IOBEAM_ADMIN_CONFIG_DB_USER"),
    ("IobeamAdmin/Json/IobeamAdmin.json", ("Database", "Password"), "IOBEAM_ADMIN_CONFIG_DB_PASSWORD"),
    ("IobeamAdmin/Json/IobeamAdmin.json", ("Database", "ConnectionString"), "IOBEAM_ADMIN_CONFIG_DB_URL"),
    (_MANIFEST, ("Deployment", "DatabaseHost"), "IOBEAM_ADMIN_CONFIG_DB_HOST"),
    (_MANIFEST, ("Deployment", "DatabaseUser"), "IOBEAM_ADMIN_CONFIG_DB_USER"),
    (_MANIFEST, ("Deployment", "DatabasePassword"), "IOBEAM_ADMIN_CONFIG_DB_PASSWORD"),
    ("IobeamAdmin/Json/IobeamAdminDb.json", ("Host",), "IOBEAM_ADMIN_DB_HOST"),
    ("IobeamAdmin/Json/IobeamAdminDb.json", ("User",), "IOBEAM_ADMIN_DB_USER"),
    ("IobeamAdmin/Json/IobeamAdminDb.json", ("Password",), "IOBEAM_ADMIN_DB_PASSWORD"),
    ("IobeamAdmin/Json/IobeamAdminDb.json", ("ConnectionString",), "IOBEAM_ADMIN_DB_URL"),
    ("OperationData/Json/OperationDataDb.json", ("Host",), "IOBEAM_OPERATION_DB_HOST"),
    ("OperationData/Json/OperationDataDb.json", ("User",), "IOBEAM_OPERATION_DB_USER"),
    ("OperationData/Json/OperationDataDb.json", ("Password",), "IOBEAM_OPERATION_DB_PASSWORD"),
    ("OperationData/Json/OperationDataDb.json", ("ConnectionString",), "IOBEAM_OPERATION_DB_URL"),
]

# Files whose values are the ones an installation actually used. Backups
# (*_default.json) and test fixtures hold placeholder logins such as a local
# test FTP account, so they are never harvested.
LIVE_FILES = [f for f in dict.fromkeys(file for file, _, _ in SECRET_BINDINGS)
              if "_default." not in f and "unit_test" not in f]

# KEY=VALUE files written by older deployments that may hold secrets.
LEGACY_ENV_FILES = ("ionbeam-web/backend/.env",)
LEGACY_ENV_KEYS = (
    "GLASGOW_TOKEN",
    "IOBEAM_ADMIN_DB_HOST", "IOBEAM_ADMIN_DB_USER", "IOBEAM_ADMIN_DB_PASSWORD",
    "IOBEAM_OPERATION_DB_HOST", "IOBEAM_OPERATION_DB_USER", "IOBEAM_OPERATION_DB_PASSWORD",
    "SMTP_USER", "SMTP_PASSWORD", "TWILIO_AUTH_TOKEN",
)


# --------------------------------------------------------------------------
# Locating and parsing the secrets file
# --------------------------------------------------------------------------
def default_secrets_path(home: Optional[str] = None) -> str:
    configured = os.environ.get(ENV_SECRETS_FILE, "").strip()
    if configured:
        return os.path.abspath(os.path.expanduser(configured))
    if home is None:
        base = os.environ.get("XDG_CONFIG_HOME", "").strip() or os.path.join(
            os.path.expanduser("~"), ".config")
    else:
        base = os.path.join(home, ".config")
    return os.path.join(base, "iobeam", "secrets.env")


def _unquote(raw: str, number: int) -> str:
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        inner = raw[1:-1]
        if raw[0] == "'":
            return inner
        return re.sub(r'\\(["\\$`])', r"\1", inner)
    if raw and raw[0] in "\"'":
        raise SecretError("secrets file line {}: unterminated quote".format(number))
    return raw


def parse_env(text: str) -> Dict[str, str]:
    """Parse systemd ``EnvironmentFile=`` syntax (the subset we write)."""
    values: Dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("export "):
            raise SecretError(
                "secrets file line {}: remove 'export' (systemd cannot read it)".format(number))
        match = _LINE.match(line)
        if not match:
            raise SecretError("secrets file line {} is not KEY=VALUE".format(number))
        values[match.group(1)] = _unquote(match.group(2).strip(), number)
    return values


def check_permissions(path: str) -> None:
    if os.name != "posix":
        return
    mode = os.stat(path).st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SecretError(
            "secrets file {} is accessible by other users (mode {:o}); run: chmod 600 {}"
            .format(path, stat.S_IMODE(mode), path))


def read_file(path: Optional[str] = None) -> Dict[str, str]:
    """Return the parsed secrets file ({} when absent). Cached by mtime."""
    path = path or default_secrets_path()
    try:
        mtime = os.stat(path).st_mtime
    except FileNotFoundError:
        return {}
    with _lock:
        cached = _cache.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
    check_permissions(path)
    with open(path, "r", encoding="utf-8") as handle:
        values = parse_env(handle.read())
    with _lock:
        _cache[path] = (mtime, values)
    return values


def get(name: str, default: Optional[str] = None, path: Optional[str] = None) -> Optional[str]:
    value = os.environ.get(name)
    if value is not None:
        return value
    reference = os.environ.get(name + "_FILE")
    if reference:
        with open(os.path.expanduser(reference), "r", encoding="utf-8") as handle:
            return handle.read().rstrip("\r\n")
    value = read_file(path).get(name)
    return value if value is not None else default


def load_into_environ(path: Optional[str] = None) -> None:
    """Export file values not already present in ``os.environ``."""
    for name, value in read_file(path).items():
        os.environ.setdefault(name, value)


# --------------------------------------------------------------------------
# Placeholders
# --------------------------------------------------------------------------
def is_placeholder(value: Any) -> bool:
    return isinstance(value, str) and bool(_FULL_PLACEHOLDER.match(value))


def placeholder(name: str, default: Optional[str] = None) -> str:
    return "${%s}" % name if default is None else "${%s:-%s}" % (name, default)


def references(value: Any) -> List[Tuple[str, Optional[str]]]:
    """Every ``(name, default)`` referenced anywhere inside ``value``."""
    found: List[Tuple[str, Optional[str]]] = []
    if isinstance(value, str):
        found.extend((m.group(1), m.group(2)) for m in PLACEHOLDER.finditer(value))
    elif isinstance(value, Mapping):
        for item in value.values():
            found.extend(references(item))
    elif isinstance(value, (list, tuple)):
        for item in value:
            found.extend(references(item))
    return found


def expand(value: Any, strict: bool = True, source: str = "configuration",
           path: Optional[str] = None, blank: bool = False) -> Any:
    """Recursively replace placeholders in JSON-like data.

    strict=False leaves unresolved required placeholders untouched so a
    caller can report them later (the deploy workflow does this); with
    blank=True as well they become "" instead (treated as "not configured").
    """
    if isinstance(value, str):
        def replace(match):
            name, default = match.group(1), match.group(2)
            resolved = get(name, None, path)
            if not resolved and default is not None:
                resolved = default  # shell semantics: ":-" also covers empty
            if resolved is None:
                if strict:
                    raise SecretError(
                        "{} references ${{{}}}, which is not set; add it to {} "
                        "(python3 -m secretstore set {}) or export it"
                        .format(source, name, path or default_secrets_path(), name))
                return "" if blank else match.group(0)
            return resolved
        return PLACEHOLDER.sub(replace, value)
    if isinstance(value, Mapping):
        return {key: expand(item, strict, source, path, blank) for key, item in value.items()}
    if isinstance(value, list):
        return [expand(item, strict, source, path, blank) for item in value]
    return value


def missing(value: Any, path: Optional[str] = None) -> List[str]:
    """Required variables referenced by ``value`` that cannot be resolved."""
    names: List[str] = []
    for name, default in references(value):
        if default is None and not get(name, None, path) and name not in names:
            names.append(name)
    return names


def load_json(file_path: str, strict: bool = True) -> Any:
    """``json.load`` + secrets-file loading + placeholder expansion."""
    with open(file_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    return expand(data, strict=strict, source=file_path)


# --------------------------------------------------------------------------
# Writing the secrets file
# --------------------------------------------------------------------------
def quote(value: str) -> str:
    if value and re.match(r"^[A-Za-z0-9_@%+=:,./-]+$", value):
        return value
    if "'" not in value:
        return "'{}'".format(value)
    return '"{}"'.format(re.sub(r'(["\\$`])', r"\\\1", value))


def write(updates: Mapping[str, str], path: Optional[str] = None,
          overwrite: bool = True) -> List[str]:
    """Insert or replace variables, atomically, keeping comments and order.

    The directory is created 0700 and the file 0600. Returns the names that
    were written. With overwrite=False, existing values are kept.
    """
    path = path or default_secrets_path()
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            lines = handle.read().splitlines()
        current = parse_env("\n".join(lines))
    except FileNotFoundError:
        lines = ["# Iobeam runtime secrets. Never commit or copy into a distribution.",
                 "# Managed with: python3 -m secretstore {set,list,check}"]
        current = {}
    written: List[str] = []
    for name, value in updates.items():
        if not _NAME.match(name):
            raise SecretError("invalid variable name: {!r}".format(name))
        value = "" if value is None else str(value)
        if "\n" in value or "\r" in value:
            raise SecretError("{} contains a newline, which systemd cannot read".format(name))
        if name in current and (not overwrite or current[name] == value):
            continue
        entry = "{}={}".format(name, quote(value))
        for index, line in enumerate(lines):
            if line.strip().startswith(name + "="):
                lines[index] = entry
                break
        else:
            lines.append(entry)
        current[name] = value
        written.append(name)
    if not written and os.path.exists(path):
        os.chmod(path, 0o600)
        return written
    fd, temporary = tempfile.mkstemp(prefix=".secrets.", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    with _lock:
        _cache.pop(path, None)
    return written


def generate(kind: str = "hex32") -> str:
    if kind == "hex32":
        return _random.token_hex(32)
    if kind == "urlsafe":
        return _random.token_urlsafe(32)
    raise SecretError("unknown generator: {}".format(kind))


# --------------------------------------------------------------------------
# Bindings: literal <-> placeholder conversion
# --------------------------------------------------------------------------
def _get_path(data: Any, keys: Iterable[Any]) -> Any:
    for key in keys:
        if isinstance(key, int):
            if not isinstance(data, list) or key >= len(data):
                return None
            data = data[key]
        else:
            if not isinstance(data, Mapping) or key not in data:
                return None
            data = data[key]
    return data


def _set_path(data: Any, keys: Tuple[Any, ...], value: Any) -> None:
    for key in keys[:-1]:
        data = data[key]
    data[keys[-1]] = value


def bindings_for(relative_file: str) -> List[Tuple[Tuple[Any, ...], str]]:
    relative_file = relative_file.replace(os.sep, "/")
    return [(keys, name) for file, keys, name in SECRET_BINDINGS
            if relative_file == file or relative_file.endswith("/" + file)]


def extract_literals(data: Any, relative_file: str) -> Tuple[Any, Dict[str, str]]:
    """Replace literal credentials in ``data`` with placeholders.

    Returns (new_data, {variable: literal}). Empty values and values that are
    already placeholders are left alone. Connection strings become an empty
    optional placeholder: their parts are bound separately.
    """
    found: Dict[str, str] = {}
    data = json.loads(json.dumps(data))
    for keys, name in bindings_for(relative_file):
        value = _get_path(data, keys)
        if not isinstance(value, str) or not value.strip() or is_placeholder(value):
            continue
        found.setdefault(name, value.strip())
        _set_path(data, keys, placeholder(name, "") if name.endswith("_URL") else placeholder(name))
    return data, found


def harvest(root: str) -> Dict[str, str]:
    """Collect literal credentials from an existing installation (first wins).

    ``root`` is the Development directory of an installation created by a
    release that still kept credentials in JSON / .env files.
    """
    def read(relative):
        with open(os.path.join(root, relative), "r", encoding="utf-8") as handle:
            return handle.read()

    values: Dict[str, str] = {}
    for relative in LIVE_FILES:
        try:
            data = json.loads(read(relative))
        except Exception:
            continue
        for name, value in extract_literals(data, relative)[1].items():
            if not name.endswith("_URL"):
                values.setdefault(name, value)
    for relative in LEGACY_ENV_FILES:
        try:
            parsed = parse_env(read(relative))
        except Exception:
            continue
        for name in LEGACY_ENV_KEYS:
            value = parsed.get(name, "").strip()
            if value and not is_placeholder(value):
                values.setdefault(name, value)
    return values


_ASSIGNMENT = re.compile(r"^\s*(?:export\s+|Environment=)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def assignments(text: str, names: Iterable[str] = LEGACY_ENV_KEYS) -> Dict[str, str]:
    """``NAME=value`` / ``export NAME=value`` lines (shell rc files, env files).

    Lenient on purpose: reads ~/.bashrc, where an older release appended
    ``export GLASGOW_TOKEN=...``. The last assignment wins, as in a shell.
    """
    wanted = set(names)
    found: Dict[str, str] = {}
    for line in text.splitlines():
        match = _ASSIGNMENT.match(line)
        if not match or match.group(1) not in wanted:
            continue
        raw = match.group(2).strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
            raw = raw[1:-1]
        elif "'" in raw or '"' in raw:  # e.g. 'a'"'"'b' from older _shquote; skip
            continue
        if raw and not PLACEHOLDER.search(raw) and not raw.startswith("$"):
            found[match.group(1)] = raw
    return found


_HANDOFF_MANIFEST = "DistributionDeploy/Json/DistributionDeploy.json"


def _manifest_values(data: Any) -> Dict[str, str]:
    values = dict(extract_literals(data, _MANIFEST)[1])
    for action in (data.get("Actions") or []) if isinstance(data, Mapping) else []:
        for body in action.values() if isinstance(action, Mapping) else []:
            exports = ((body or {}).get("actionData") or {}).get("exports") or {}
            token = exports.get("GLASGOW_TOKEN") if isinstance(exports, Mapping) else None
            token = token.get("value") if isinstance(token, Mapping) else token
            if isinstance(token, str) and token.strip() and not PLACEHOLDER.search(token):
                values.setdefault("GLASGOW_TOKEN", token.strip())
    return {k: v for k, v in values.items() if not k.endswith("_URL")}


def _dist_values(archive: "zipfile.ZipFile") -> Dict[str, str]:
    values: Dict[str, str] = {}
    names = archive.namelist()
    for relative in LIVE_FILES:
        member = next((n for n in names if n.endswith("Development/" + relative)), None)
        if member is None:
            continue
        try:
            data = json.loads(archive.read(member).decode("utf-8"))
        except Exception:
            continue
        for name, value in extract_literals(data, relative)[1].items():
            if not name.endswith("_URL"):
                values.setdefault(name, value)
    return values


def harvest_handoff(path: str) -> Dict[str, str]:
    """Credentials inside an older DeployWorkspace handoff (zip or extracted folder).

    Releases before the secrets file shipped them in the deploy manifest
    (database login, GLASGOW_TOKEN) and in dist_app.zip (FTP, database).
    """
    values: Dict[str, str] = {}
    try:
        if os.path.isfile(path) and zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as outer:
                for name in outer.namelist():
                    if name.endswith(_HANDOFF_MANIFEST):
                        for k, v in _manifest_values(json.loads(outer.read(name).decode("utf-8"))).items():
                            values.setdefault(k, v)
                for name in outer.namelist():
                    if re.search(r"(^|/)dist_app[^/]*\.zip$", name):
                        with zipfile.ZipFile(io.BytesIO(outer.read(name))) as inner:
                            for k, v in _dist_values(inner).items():
                                values.setdefault(k, v)
        elif os.path.isdir(path):
            for current, directories, files in os.walk(path):
                depth = os.path.relpath(current, path).count(os.sep)
                if depth > 5:
                    directories[:] = []
                    continue
                for name in files:
                    full = os.path.join(current, name)
                    if full.replace(os.sep, "/").endswith(_HANDOFF_MANIFEST):
                        with open(full, "r", encoding="utf-8") as handle:
                            for k, v in _manifest_values(json.load(handle)).items():
                                values.setdefault(k, v)
                    elif re.match(r"dist_app[^/]*\.zip$", name) and zipfile.is_zipfile(full):
                        with zipfile.ZipFile(full) as inner:
                            for k, v in _dist_values(inner).items():
                                values.setdefault(k, v)
    except Exception:
        return values
    return values


def find_handoffs(directories: Iterable[str]) -> List[str]:
    """DeployWorkspace_* archives and extracted folders, newest first."""
    found = {}
    for directory in directories:
        try:
            entries = os.listdir(directory)
        except OSError:
            continue
        for name in entries:
            if name.startswith("DeployWorkspace") or name == "DeployWorkSpace":
                full = os.path.realpath(os.path.join(directory, name))
                try:
                    found[full] = os.stat(full).st_mtime
                except OSError:
                    continue
    return sorted(found, key=lambda p: found[p], reverse=True)


# --------------------------------------------------------------------------
# Provisioning: the variables an installation needs, and how to fill them
# (shared by the deploy workflow's provisionSecrets action and
# ``python3 -m secretstore init``).
# --------------------------------------------------------------------------
VARIABLES: List[Dict[str, Any]] = [
    {"name": "IOBEAM_ADMIN_CONFIG_DB_HOST",
     "description": "Admin database server the app queries (IobeamAdmin.json Database.Host)",
     "unset": "the app uses the local admin database created by this deployment"},
    {"name": "IOBEAM_ADMIN_CONFIG_DB_USER",
     "description": "Admin database login (IobeamAdmin.json Database.User)",
     "unset": "the app uses the local admin database created by this deployment"},
    {"name": "IOBEAM_ADMIN_CONFIG_DB_PASSWORD", "secret": True,
     "description": "Admin database password (IobeamAdmin.json Database.Password)",
     "unset": "the app uses the local admin database created by this deployment"},
    {"name": "IOBEAM_ADMIN_DB_PASSWORD", "secret": True, "generate": "urlsafe",
     "description": "Password of the local runtime role the installer creates"},
    {"name": "GLASGOW_TOKEN", "required": True, "secret": True, "generate": "hex32",
     "description": "Bearer token shared by ionbeam-web and glasgow_service"},
    {"name": "IOBEAM_FTP_HOST",
     "description": "FTP server for scan CSV/PNG upload", "unset": "scan upload to FTP is disabled"},
    {"name": "IOBEAM_FTP_USER", "description": "FTP login", "unset": "scan upload to FTP is disabled"},
    {"name": "IOBEAM_FTP_PASSWORD", "secret": True, "description": "FTP password",
     "unset": "scan upload to FTP is disabled"},
]


def read_seed(path: str) -> Dict[str, str]:
    """Values from an operator-prepared file (same KEY=VALUE syntax)."""
    path = os.path.abspath(os.path.expanduser(path))
    with open(path, "r", encoding="utf-8") as handle:
        return {k: v for k, v in parse_env(handle.read()).items() if v != ""}


class ProvisionResult(object):
    def __init__(self, path):
        self.path = path
        self.sources = {}        # variable -> where its value came from
        self.written = []        # variables written to the file this run
        self.missing = []        # required variables still empty


def provision(path: Optional[str] = None, variables: Optional[List[Dict[str, Any]]] = None,
              seed: Optional[Mapping[str, str]] = None, harvested: Optional[Mapping[str, str]] = None,
              environ: Optional[Mapping[str, str]] = None, ask=None) -> ProvisionResult:
    """Create or complete the secrets file.

    For each variable the first available source wins:
      seed file (explicit operator input; replaces stored values),
      value already in the secrets file, the environment, a harvested legacy
      value, a generator, then ``ask(variable)`` (interactive prompt).
    Values the seed or harvest provide beyond ``variables`` (SMTP, Twilio...)
    are stored as well. Nothing is ever printed or logged by this function.
    """
    path = path or default_secrets_path()
    variables = VARIABLES if variables is None else variables
    seed = dict(seed or {})
    harvested = dict(harvested or {})
    environ = os.environ if environ is None else environ
    result = ProvisionResult(path)
    current = read_file(path)

    updates: Dict[str, str] = {}
    for name, value in seed.items():
        updates[name] = value
        result.sources[name] = "secrets file given to the deploy"
    pending = []
    for variable in variables:
        name = str(variable["name"])
        if name in updates:
            continue
        if current.get(name):
            result.sources[name] = "existing secrets file"
            continue
        for source, value in (("environment", environ.get(name, "")),
                              ("previous installation", harvested.get(name, ""))):
            if value:
                updates[name] = value
                result.sources[name] = source
                break
        else:
            if variable.get("generate"):
                updates[name] = generate(variable["generate"])
                result.sources[name] = "generated"
            else:
                pending.append(variable)
    for name, value in harvested.items():
        if name not in current and name not in updates:
            updates[name] = value
            result.sources[name] = "previous installation"

    # Store everything gathered so far before asking, so an interrupted
    # prompt never loses harvested or generated values.
    result.written = write(updates, path, overwrite=True)
    if pending and ask is not None:
        for variable in pending:
            value = ask(variable)
            if value:  # saved at once: an interrupted prompt keeps earlier answers
                result.written += write({str(variable["name"]): value}, path, overwrite=True)
                result.sources[str(variable["name"])] = "entered at prompt"

    final = read_file(path)
    result.missing = [str(v["name"]) for v in variables
                      if v.get("required") and not (environ.get(str(v["name"])) or final.get(str(v["name"])))]
    return result


def prompt(variable) -> str:
    """Ask for one variable on the terminal (hidden and repeated for secrets)."""
    label = "{} [{}]".format(variable.get("description") or variable["name"], variable["name"])
    optional = "" if variable.get("required") else " (optional, Enter to skip)"
    if variable.get("secret"):
        while True:
            first = getpass.getpass("{}{}: ".format(label, optional)).strip()
            if not first or getpass.getpass("Repeat {}: ".format(variable["name"])).strip() == first:
                return first
            print("Values did not match; try again.", file=sys.stderr)
    sys.stdout.write("{}{}: ".format(label, optional))
    sys.stdout.flush()
    return sys.stdin.readline().strip()


def unresolved_variables(variables: Optional[List[Dict[str, Any]]] = None,
                         path: Optional[str] = None) -> List[Dict[str, Any]]:
    """The variables that currently have no value anywhere."""
    variables = VARIABLES if variables is None else variables
    return [v for v in variables if not get(str(v["name"]), None, path)]


# --------------------------------------------------------------------------
# Scanning for literal credentials (build gate and tests)
# --------------------------------------------------------------------------
_SENSITIVE_KEY = re.compile(
    r"pass(word|wd)?$|pwd$|secret|token|api_?key|private_?key|credential|connection_?string"
    r"|^(ftp|sftp|smtp|db|database|admin)?_?user(name)?$",
    re.IGNORECASE)
_URL_PASSWORD = re.compile(r"[a-z][a-z0-9+.-]*://[^/\s:@\"'$]+:[^@\s\"'$/{]+@", re.IGNORECASE)
_ENV_SECRET = re.compile(
    r"^\s*(?:Environment=)?([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY))"
    r"\s*=\s*['\"]?([^'\"\s#]*)")
_EXAMPLE_VALUE = re.compile(r"^(change[-_]?me|replace[-_].*|example.*|x{3,}|<[^>]*>)$", re.IGNORECASE)
# Keys whose literal value is configuration, not a credential.
_ALLOWED_KEYS = {"DatabaseOwnerRole", "databaseRole", "databaseOwnerRole"}


def scan_json(data: Any, where: str = "") -> List[str]:
    problems: List[str] = []
    if isinstance(data, Mapping):
        for key, value in data.items():
            location = "{}.{}".format(where, key) if where else str(key)
            if (isinstance(value, str) and value.strip() and _SENSITIVE_KEY.search(str(key))
                    and str(key) not in _ALLOWED_KEYS and not is_placeholder(value)):
                problems.append("{}: literal value (use a ${{VAR}} placeholder)".format(location))
            elif isinstance(value, Mapping) and _SENSITIVE_KEY.search(str(key)) \
                    and "value" in value and isinstance(value["value"], str) \
                    and value["value"].strip() and not is_placeholder(value["value"]):
                problems.append("{}.value: literal value".format(location))
            problems.extend(scan_json(value, location))
    elif isinstance(data, list):
        for index, item in enumerate(data):
            problems.extend(scan_json(item, "{}[{}]".format(where, index)))
    elif isinstance(data, str) and _URL_PASSWORD.search(data):
        problems.append("{}: password embedded in a URL".format(where))
    return problems


def scan_text(text: str) -> List[str]:
    problems: List[str] = []
    for number, line in enumerate(text.splitlines(), start=1):
        match = _ENV_SECRET.match(line)
        if (match and match.group(2) and not PLACEHOLDER.search(match.group(2))
                and not _EXAMPLE_VALUE.match(match.group(2))):
            problems.append("line {}: {} has a literal value".format(number, match.group(1)))
        if _URL_PASSWORD.search(line):
            problems.append("line {}: password embedded in a URL".format(number))
    return problems


SCANNED_SUFFIXES = (".json", ".env", ".service", ".service.in", ".env.example", ".env.in")


def scan_file(path: str) -> List[str]:
    name = os.path.basename(path)
    if not (name.endswith(SCANNED_SUFFIXES) or name == ".env"):
        return []
    if name in ("package.json", "package-lock.json") or name.startswith("tsconfig"):
        return []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except (OSError, UnicodeDecodeError):
        return []
    if name.endswith(".json"):
        try:
            return scan_json(json.loads(text))
        except ValueError:
            return []
    return scan_text(text)


def scan_tree(root: str, skip_dirs: Iterable[str] = ("node_modules", ".git", ".venv", "__pycache__",
                                                     "dist", "runtime", "vendor", "i18n",
                                                     "locales")) -> List[str]:
    skip = set(skip_dirs)
    problems: List[str] = []
    for current, directories, names in os.walk(root):
        directories[:] = sorted(d for d in directories if d not in skip)
        for name in sorted(names):
            path = os.path.join(current, name)
            for problem in scan_file(path):
                problems.append("{}: {}".format(os.path.relpath(path, root), problem))
    return problems
