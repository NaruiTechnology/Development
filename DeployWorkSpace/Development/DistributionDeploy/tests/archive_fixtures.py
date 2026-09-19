"""Helpers that build small, valid, manifested distribution archives for tests.

They use the real producer (distributionManifest), so the archives are exactly
what the real builder would emit for the same members.
"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import distributionManifest  # noqa: E402


def manifest_for(members, *, compiled=False, python=None, required=()):
    files = {name: {"sha256": distributionManifest.sha256_bytes(data), "size": len(data)}
             for name, data in members.items()}
    return distributionManifest.build_manifest(
        files, compiled=compiled, required=list(required), python=python,
        version="0.0-test", git={"commit": "a" * 40, "dirty": False})


def write_manifested_archive(path, members, *, compiled=False, python=None, required=()):
    """Write ``members`` ({archive path: bytes}) plus a matching manifest."""
    manifest = manifest_for(members, compiled=compiled, python=python, required=required)
    with zipfile.ZipFile(path, "w") as bundle:
        for name, data in members.items():
            bundle.writestr(name, data)
        bundle.writestr(distributionManifest.MANIFEST_NAME,
                        distributionManifest.json.dumps(manifest, sort_keys=True))
    return manifest
