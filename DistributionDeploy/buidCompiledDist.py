#-------------------------------------------------------------------------------
# buidCompiledDist.py
#
# Builds a distributable manifest of the project tree:
#   1. Compile every .py to bytecode (.pyc) via compileall.
#   2. Walk the source tree and copy clean-named .pyc files into ``--dist`` dir.
#   3. Copy declared JSON config trees verbatim.
#   4. Copy a configurable set of asset patterns (e.g. *.ihex, requirements.txt).
#   5. Optionally copy the project's .venv directory.
#   6. Pack the whole dist directory into a single .zip for transport.
#
# This file is the build-side counterpart to the DistributionDeploy workflow:
# the workflow's first action invokes this script, then ships the resulting
# zip to the target host where the remaining actions unpack and bootstrap.
#
# Usage:
#   python3 buidCompiledDist.py                                  # defaults
#   python3 buidCompiledDist.py --source . --dist dist_app --output dist_app.zip
#   python3 buidCompiledDist.py --no-zip                         # folder only
#   python3 buidCompiledDist.py --no-venv                        # skip .venv copy
#-------------------------------------------------------------------------------
import argparse
import compileall
import fnmatch
import os
import re
import shutil
import sys
import zipfile

# ---------------------------------------------------------------------------
# Defaults (overridable via CLI)
# ---------------------------------------------------------------------------

# Files (by name or glob) to copy verbatim into dist, preserving directory
# structure. requirements.txt files are critical for the deploy step that
# walks the dist tree and pip-installs them.
DEFAULT_ASSET_PATTERNS = ['*.ihex', 'requirements.txt']

# Directories never walked into during compile/copy.
DEFAULT_SKIP_DIRS = {
    '__pycache__', '.venv', '.git', 'dist_app',
    'EsmBeamController', 'Open-Beam-Interface',
    'node_modules',
}

# Non-python asset trees copied wholesale.
DEFAULT_JSON_SOURCES = [
    os.path.join('Development', 'GlasgowDataIO', 'Json'),
    os.path.join('Development', 'LoadFPGAImage', 'Json'),
    os.path.join('GlasgowDataIO', 'Json'),
    os.path.join('DistributionDeploy', 'Json'),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def copy_matching_assets(src_dir, dist_dir, patterns, skip_dirs):
    """Walk *src_dir* and copy any files matching *patterns* into *dist_dir*,
    preserving the relative directory structure."""
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        # Prune skipped dirs in place
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        # Don't recurse into the output folder if it lives under src_dir
        if os.path.abspath(root).startswith(abs_dist):
            continue
        for filename in files:
            if any(fnmatch.fnmatch(filename, pat) for pat in patterns):
                rel_path = os.path.relpath(root, src_dir)
                target_folder = os.path.join(dist_dir, rel_path)
                os.makedirs(target_folder, exist_ok=True)
                src_file = os.path.join(root, filename)
                dest_file = os.path.join(target_folder, filename)
                shutil.copy2(src_file, dest_file)
                print(f"Copied asset: {os.path.join(rel_path, filename)}")


def compile_sources(src_dir, dist_dir, skip_dirs):
    """Compile .py -> .pyc, then mirror clean-named .pyc files into dist_dir."""
    print(f"Compiling source in {src_dir}...")
    compileall.compile_dir(src_dir, force=True, quiet=True)

    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        if os.path.abspath(root).startswith(abs_dist):
            continue
        # Keep '__pycache__' available for the check below, prune the rest
        dirs[:] = [d for d in dirs if d == '__pycache__' or d not in skip_dirs]
        if '__pycache__' in dirs:
            cache_path = os.path.join(root, '__pycache__')
            rel_path = os.path.relpath(root, src_dir)
            target_folder = os.path.join(dist_dir, rel_path)
            os.makedirs(target_folder, exist_ok=True)

            for filename in os.listdir(cache_path):
                # Match the pattern: name.cpython-XY.pyc
                match = re.match(r"(.+)\.cpython-\d+\.pyc", filename)
                if match:
                    clean_name = f"{match.group(1)}.pyc"
                    src_file = os.path.join(cache_path, filename)
                    dest_file = os.path.join(target_folder, clean_name)
                    shutil.copy2(src_file, dest_file)
                    print(f"Packaged: {clean_name}")


def copy_json_sources(src_dir, dist_dir, json_sources):
    """Copy each declared JSON config tree into the dist folder."""
    for jx in json_sources:
        json_src = os.path.join(src_dir, jx)
        if os.path.exists(json_src):
            json_dist = os.path.join(dist_dir, jx)
            if os.path.exists(json_dist):
                shutil.rmtree(json_dist)
            shutil.copytree(json_src, json_dist)
            print(f"Copied JSON configuration files [{jx}].")


def copy_venv(src_dir, dist_dir):
    """Copy the project's .venv tree into dist if one exists."""
    venv_src = os.path.join(src_dir, '.venv')
    if os.path.exists(venv_src):
        venv_dist = os.path.join(dist_dir, '.venv')
        if os.path.exists(venv_dist):
            shutil.rmtree(venv_dist)
        shutil.copytree(venv_src, venv_dist, symlinks=True)
        print("Copied virtual environment.")
    else:
        print("No .venv to copy (skipping).")


def zip_dist(dist_dir, output_zip):
    """Pack *dist_dir* into a single zip archive at *output_zip*."""
    if os.path.exists(output_zip):
        os.remove(output_zip)
    abs_dist = os.path.abspath(dist_dir)
    abs_out = os.path.abspath(output_zip)

    with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for root, _, files in os.walk(dist_dir):
            for f in files:
                full = os.path.join(root, f)
                # Don't accidentally include the output zip itself if it lives in dist_dir
                if os.path.abspath(full) == abs_out:
                    continue
                arcname = os.path.relpath(full, abs_dist)
                zf.write(full, arcname)
    size_mb = os.path.getsize(output_zip) / (1024 * 1024)
    print(f"Packed distribution -> {output_zip} ({size_mb:.2f} MB)")


# ---------------------------------------------------------------------------
# Main builder
# ---------------------------------------------------------------------------

def build_compiled_dist(src_dir, dist_dir, output_zip=None,
                        asset_patterns=None, skip_dirs=None,
                        json_sources=None, copy_venv_flag=True):
    asset_patterns = asset_patterns or DEFAULT_ASSET_PATTERNS
    skip_dirs = skip_dirs or DEFAULT_SKIP_DIRS
    json_sources = json_sources if json_sources is not None else DEFAULT_JSON_SOURCES

    # Reset dist folder
    if os.path.exists(dist_dir):
        shutil.rmtree(dist_dir)
    os.makedirs(dist_dir)

    # 1. Compile + copy .pyc
    compile_sources(src_dir, dist_dir, skip_dirs)

    # 2. JSON config trees
    copy_json_sources(src_dir, dist_dir, json_sources)

    # 3. Other assets matching patterns (e.g. *.ihex firmware, requirements.txt)
    copy_matching_assets(src_dir, dist_dir, asset_patterns, skip_dirs)

    # 4. .venv tree (optional)
    if copy_venv_flag:
        copy_venv(src_dir, dist_dir)

    # 5. Pack into a single zip manifest
    if output_zip:
        zip_dist(dist_dir, output_zip)

    return dist_dir, output_zip


def _parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Build a compiled, zipped distribution of the project.")
    p.add_argument('--source', default='.', help="Source root (default: '.').")
    p.add_argument('--dist', default='./dist_app',
                   help="Output dist folder (default: './dist_app').")
    p.add_argument('--output', default='dist_app.zip',
                   help="Output zip file (default: 'dist_app.zip'). "
                        "Pass empty string or use --no-zip to skip zipping.")
    p.add_argument('--no-zip', action='store_true',
                   help="Build folder only; do not produce a zip.")
    p.add_argument('--no-venv', action='store_true',
                   help="Do not copy the project's .venv directory.")
    return p.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv)
    output_zip = None if args.no_zip or not args.output else args.output

    dist_dir, zip_path = build_compiled_dist(
        src_dir=args.source,
        dist_dir=args.dist,
        output_zip=output_zip,
        copy_venv_flag=not args.no_venv,
    )
    print(f"\nBuild complete. Folder: {dist_dir}"
          + (f"  Zip: {zip_path}" if zip_path else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
