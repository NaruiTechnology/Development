"""Distribution manifest: the single producer *and* verifier.

The builder (``Development/buidCompiledDist.py``) writes ``dist_manifest.json``
into the archive; the deploy workflow verifies it before it stops or deletes
anything, and again after extraction. Both sides use this one file, so they
cannot disagree about the format. Standard library only, so it runs on a bare
deploy host and inside the builder.

What the manifest records
  * every packaged file: SHA-256 and size (and, for compiled ``.pyc`` files, the
    SHA-256 of the exact source they were compiled from),
  * the Python that produced any bytecode (version, cache tag, magic number),
  * the git commit and dirty flag when available, the config ``Version``, and
    the list of members a working deployment cannot do without.

Why: a compiled archive built by one interpreter cannot be imported by another
("bad magic number"), and a stale or partial archive is otherwise
indistinguishable from a good one. Before this file existed, nothing could tell
which code a deployed host was actually running.
"""
import hashlib
import importlib.util
import json
import os
import platform
import subprocess
import sys
import zipfile
from datetime import datetime, timezone

SCHEMA_VERSION = 1
MANIFEST_NAME = "dist_manifest.json"
_CHUNK = 1 << 20
_MAX_EXAMPLES = 8


class ManifestError(Exception):
    """The distribution is missing, inconsistent, or not usable on this host."""


# ---------------------------------------------------------------- hashing ---
def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(_CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def _sha256_stream(stream):
    digest, size = hashlib.sha256(), 0
    for block in iter(lambda: stream.read(_CHUNK), b""):
        digest.update(block)
        size += len(block)
    return digest.hexdigest(), size


# --------------------------------------------------------------- identity ---
def python_identity():
    return {
        "version": platform.python_version(),
        "cache_tag": sys.implementation.cache_tag,
        "magic": importlib.util.MAGIC_NUMBER.hex(),
    }


def git_identity(path):
    """Best-effort commit and dirty flag; ``None`` values when git is absent."""
    def run(*args):
        return subprocess.run(
            ["git", "-C", str(path)] + list(args), capture_output=True,
            text=True, timeout=15, check=True).stdout.strip()
    try:
        return {"commit": run("rev-parse", "HEAD"),
                "dirty": bool(run("status", "--porcelain"))}
    except (OSError, subprocess.SubprocessError):
        return {"commit": None, "dirty": None}


# --------------------------------------------------------------- producer ---
def describe_tree(root, compiled_sources=None):
    """Return ``{relative posix path: {sha256, size[, source_sha256]}}``."""
    compiled_sources = compiled_sources or {}
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if rel == MANIFEST_NAME:
                continue
            if os.path.islink(full):
                raise ManifestError("symlink not allowed in distribution: " + rel)
            entry = {"sha256": sha256_file(full), "size": os.path.getsize(full)}
            if rel in compiled_sources:
                entry["source_sha256"] = compiled_sources[rel]
            files[rel] = entry
    return files


def build_manifest(files, *, compiled, required, version=None, git=None,
                   python=None, created=None):
    return {
        "schema": SCHEMA_VERSION,
        "created_utc": created or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "compiled": bool(compiled),
        "python": python or python_identity(),
        "version": version,
        "git": git or {"commit": None, "dirty": None},
        "required": sorted(required),
        "file_count": len(files),
        "files": files,
    }


def write_manifest(root, manifest):
    path = os.path.join(root, MANIFEST_NAME)
    with open(path, "w", encoding="utf-8") as stream:
        json.dump(manifest, stream, indent=1, sort_keys=True)
        stream.write("\n")
    return path


# --------------------------------------------------------------- consumer ---
def _validate_shape(manifest):
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA_VERSION:
        raise ManifestError("unsupported manifest schema: %r (expected %d)"
                            % (manifest.get("schema") if isinstance(manifest, dict) else manifest,
                               SCHEMA_VERSION))
    for key in ("compiled", "python", "required", "files"):
        if key not in manifest:
            raise ManifestError("manifest is missing '%s'" % key)
    if manifest["compiled"] and "magic" not in manifest["python"]:
        raise ManifestError("compiled manifest does not record the bytecode magic number")


def check_compatibility(manifest, magic=None):
    """Refuse bytecode this interpreter cannot import."""
    if not manifest["compiled"]:
        return
    magic = importlib.util.MAGIC_NUMBER if magic is None else magic
    built = manifest["python"]
    if built["magic"] != magic.hex():
        raise ManifestError(
            "archive holds bytecode built by %s (%s, magic %s) but this host runs %s "
            "(%s, magic %s). Rebuild the distribution with the deploy host's Python, "
            "or build with --raw." % (
                built.get("cache_tag"), built.get("version"), built["magic"],
                sys.implementation.cache_tag, platform.python_version(), magic.hex()))


def _examples(items):
    items = sorted(items)
    more = "" if len(items) <= _MAX_EXAMPLES else " (+%d more)" % (len(items) - _MAX_EXAMPLES)
    return ", ".join(items[:_MAX_EXAMPLES]) + more


def _unsafe_member(name):
    parts = name.replace("\\", "/").split("/")
    return name.startswith(("/", "\\")) or ".." in parts or (len(name) > 1 and name[1] == ":")


def load_manifest(archive):
    try:
        raw = archive.read(MANIFEST_NAME)
    except KeyError:
        raise ManifestError(
            "archive has no %s; it was not produced by the current builder. "
            "Rebuild it with Development/buidCompiledDist.py." % MANIFEST_NAME)
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise ManifestError("%s is not valid JSON: %s" % (MANIFEST_NAME, exc))


def verify_zip(zip_path, *, magic=None):
    """Verify an archive end to end. Returns the manifest; raises ManifestError."""
    try:
        archive = zipfile.ZipFile(zip_path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ManifestError("cannot open archive %s: %s" % (zip_path, exc))
    with archive:
        bad = archive.testzip()
        if bad:
            raise ManifestError("corrupt archive member: %s" % bad)
        manifest = load_manifest(archive)
        _validate_shape(manifest)
        check_compatibility(manifest, magic)

        members = {i.filename for i in archive.infolist() if not i.is_dir()}
        members.discard(MANIFEST_NAME)
        unsafe = [m for m in members if _unsafe_member(m)]
        if unsafe:
            raise ManifestError("unsafe archive member path(s): " + _examples(unsafe))
        listed = set(manifest["files"])
        problems = []
        if listed - members:
            problems.append("missing from archive: " + _examples(listed - members))
        if members - listed:
            problems.append("not in manifest: " + _examples(members - listed))
        absent = [r for r in manifest["required"] if r not in members]
        if absent:
            problems.append("required member(s) absent: " + _examples(absent))
        changed = []
        for rel in sorted(listed & members):
            expected = manifest["files"][rel]
            with archive.open(rel) as stream:
                digest, size = _sha256_stream(stream)
            if digest != expected["sha256"] or size != expected["size"]:
                changed.append(rel)
        if changed:
            problems.append("content differs from manifest: " + _examples(changed))
        if problems:
            raise ManifestError("distribution failed verification; " + "; ".join(problems))
    return manifest


def verify_tree(root, manifest):
    """Verify an extracted tree against its manifest. Returns files checked."""
    _validate_shape(manifest)
    missing, changed = [], []
    for rel, expected in manifest["files"].items():
        full = os.path.join(root, *rel.split("/"))
        if not os.path.isfile(full):
            missing.append(rel)
        elif (os.path.getsize(full) != expected["size"]
              or sha256_file(full) != expected["sha256"]):
            changed.append(rel)
    problems = []
    if missing:
        problems.append("missing after extraction: " + _examples(missing))
    if changed:
        problems.append("content differs from manifest: " + _examples(changed))
    if problems:
        raise ManifestError("deployed tree failed verification; " + "; ".join(problems))
    return len(manifest["files"])


def summarize(manifest):
    git = manifest.get("git") or {}
    commit = (git.get("commit") or "unknown")[:12]
    dirty = {True: "+dirty", False: "", None: "?"}[git.get("dirty")]
    py = manifest["python"]
    return ("version=%s commit=%s%s built=%s mode=%s python=%s files=%d" % (
        manifest.get("version"), commit, dirty, manifest.get("created_utc"),
        "compiled(%s)" % py.get("cache_tag") if manifest["compiled"] else "raw",
        py.get("version"), len(manifest["files"])))
