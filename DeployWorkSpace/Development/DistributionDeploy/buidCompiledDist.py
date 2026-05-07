#-------------------------------------------------------------------------------
# buidCompiledDist.py
#
# Builds a distributable manifest of the project tree. Two compile modes:
#
#   --use-cython  (DEFAULT, recommended for Ubuntu deploy)
#       For each .py source file:
#         1. cython -3 file.py -> file.c       (Python -> annotated C)
#         2. cc -shared -fPIC file.c -> file.cpython-XYZ-linux-gnu.so
#         3. file.c is deleted
#       Result: native ELF shared objects. The original Python source is
#       NOT recoverable -- the .so contains compiled machine code, not
#       bytecode. Resistant to decompyle3 / uncompyle6 / inspect.getsource.
#
#   --use-pyc
#       Original behavior: compileall + copy clean-named .pyc files.
#       Faster build, but .pyc is trivially decompiled back to .py source.
#       Kept as a fallback / dev-iteration mode.
#
# In either mode, "entry-point" scripts are kept as .py so they can be
# invoked directly with `python3 script.py`. Defaults match this project:
#   - buidCompiledDist.py itself
#   - *App.py files (project convention: loadFPGAImageApp.py etc.)
#   - setup.py, __main__.py
#
# Use --keep-py PATTERN (repeatable) to add more.
#
# Both modes also:
#   - Copy declared JSON config trees verbatim
#   - Copy asset patterns (e.g. *.ihex, requirements.txt)
#   - Optionally copy the project's .venv
#   - Pack the dist folder into a single .zip
#
# Build-host requirements for --use-cython:
#   - cython 3.x          (pip install Cython)
#   - cc / gcc            (apt install build-essential)
#   - python3-dev headers (apt install python3-dev)
#
# Deploy-host requirement for --use-cython:
#   - same Python major.minor as the build host. The .so files are tied
#     to the CPython ABI (e.g. .cpython-312-x86_64-linux-gnu.so will only
#     load under Python 3.12 on x86_64 Linux). The build report at the
#     start of a Cython run prints the exact ABI tag so you can match it.
#-------------------------------------------------------------------------------
import argparse
import compileall
import fnmatch
import os
import re
import shutil
import subprocess
import sys
import sysconfig
import zipfile

# ---------------------------------------------------------------------------
# Defaults (overridable via CLI)
# ---------------------------------------------------------------------------
DEFAULT_ASSET_PATTERNS = ['*.ihex', 'requirements.txt']

DEFAULT_SKIP_DIRS = {
    '__pycache__', '.venv', '.git', 'dist_app',
    'DistributionDeploy', 'Open-Beam-Interface',
    'node_modules', 'DistributionDeploy',
}

# JSON config trees copied wholesale.
DEFAULT_JSON_SOURCES = [
    os.path.join('Development', 'GlasgowDataIO', 'Json'),
    os.path.join('Development', 'LoadFPGAImage', 'Json'),
    os.path.join('GlasgowDataIO', 'Json'),
    os.path.join('DistributionDeploy', 'Json'),
]

# Non-Python application trees copied as source/assets.
DEFAULT_COPY_TREES = [
    os.path.join('Development', 'ionbeam-web'),
]

# Files NOT compiled by Cython -- copied as plain .py so they remain
# directly invokable with `python3 <file>`. Glob patterns matched against
# paths relative to --source.
DEFAULT_KEEP_PY = [
    'buidCompiledDist.py',
    '*App.py',           # project entry-point convention
    'setup.py',
    '__main__.py',
]


# ---------------------------------------------------------------------------
# Cython compile path
# ---------------------------------------------------------------------------

class CythonToolchain(object):
    """Resolves cython + cc + Python ABI info once and caches it."""

    def __init__(self):
        self.cython_bin = shutil.which('cython') or shutil.which('cython3')
        self.cc_bin = shutil.which('cc') or shutil.which('gcc')
        self.ext_suffix = sysconfig.get_config_var('EXT_SUFFIX') or '.so'
        py_inc = sysconfig.get_path('include')
        plat_inc = sysconfig.get_path('platinclude')
        self.includes = [py_inc] if py_inc else []
        if plat_inc and plat_inc != py_inc:
            self.includes.append(plat_inc)

    def check(self):
        missing = []
        if not self.cython_bin:
            missing.append("'cython' (pip install Cython)")
        if not self.cc_bin:
            missing.append("a C compiler (apt install build-essential)")
        if not self.includes or not os.path.isdir(self.includes[0]):
            missing.append("Python development headers (apt install python3-dev)")
        if missing:
            raise RuntimeError(
                "Cython mode unavailable, missing:\n  - " + "\n  - ".join(missing))

    def report(self):
        print("Cython toolchain:")
        print(f"  cython:     {self.cython_bin}")
        print(f"  cc:         {self.cc_bin}")
        print(f"  ext suffix: {self.ext_suffix}")
        print(f"  includes:   {self.includes}")


def _is_trivial_py(path):
    """True if the file is empty or contains only comments / whitespace.

    Empty __init__.py files in particular have no IP to protect, so we
    just copy them verbatim instead of running them through Cython.
    """
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith('#'):
                    continue
                return False
        return True
    except OSError:
        return False


def _is_entry_point(rel_path, keep_patterns):
    """True if rel_path matches any of the keep-as-.py glob patterns."""
    base = os.path.basename(rel_path)
    for pat in keep_patterns:
        if fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(base, pat):
            return True
    return False


def _cython_compile_one(toolchain, src_py, target_dir, base_name, verbose=False):
    """Compile a single .py file to a .so in target_dir.

    Returns the full path to the produced .so on success, raises on failure.
    """
    os.makedirs(target_dir, exist_ok=True)
    c_file = os.path.join(target_dir, base_name + '.c')
    so_file = os.path.join(target_dir, base_name + toolchain.ext_suffix)

    # 1) Python -> C
    cy_cmd = [toolchain.cython_bin, '-3', '--fast-fail',
              '-o', c_file, src_py]
    res = subprocess.run(cy_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(
            "cython failed for {}\nstderr:\n{}".format(src_py, res.stderr))

    # 2) C -> .so
    cc_cmd = [toolchain.cc_bin, '-shared', '-fPIC', '-O2', '-Wall',
              '-Wno-unused-function', '-Wno-unused-variable',
              '-Wno-deprecated-declarations']
    for inc in toolchain.includes:
        cc_cmd += ['-I', inc]
    cc_cmd += [c_file, '-o', so_file]

    res = subprocess.run(cc_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        # Keep the .c around for diagnosis on failure
        raise RuntimeError(
            "cc failed for {}\ncommand: {}\nstderr:\n{}".format(
                src_py, ' '.join(cc_cmd), res.stderr))

    # 3) cleanup
    try:
        os.remove(c_file)
    except OSError:
        pass

    if verbose:
        size_kb = os.path.getsize(so_file) / 1024.0
        print(f"  Cythonized: {os.path.basename(so_file)} ({size_kb:.1f} KB)")
    return so_file


def cython_compile_tree(src_dir, dist_dir, skip_dirs, keep_patterns,
                        verbose=False):
    """Walk src_dir, Cython-compile all .py files into dist_dir.

    Files matching keep_patterns are copied verbatim instead of compiled.
    Trivial __init__.py files (empty / comments only) are also copied.
    """
    toolchain = CythonToolchain()
    toolchain.check()
    toolchain.report()

    abs_dist = os.path.abspath(dist_dir)
    compiled = 0
    kept = 0
    skipped_trivial = 0

    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        if os.path.abspath(root).startswith(abs_dist):
            continue

        rel_root = os.path.relpath(root, src_dir)
        target_root = (dist_dir if rel_root == '.'
                       else os.path.join(dist_dir, rel_root))
        os.makedirs(target_root, exist_ok=True)

        for fname in files:
            if not fname.endswith('.py'):
                continue
            full_src = os.path.join(root, fname)
            rel_src = (fname if rel_root == '.'
                       else os.path.join(rel_root, fname))

            # Entry-points: keep as .py
            if _is_entry_point(rel_src, keep_patterns):
                shutil.copy2(full_src, os.path.join(target_root, fname))
                kept += 1
                if verbose:
                    print(f"  Kept (entry-point): {rel_src}")
                continue

            # Empty / trivial __init__.py: keep as .py (no IP to protect)
            if fname == '__init__.py' and _is_trivial_py(full_src):
                shutil.copy2(full_src, os.path.join(target_root, fname))
                skipped_trivial += 1
                if verbose:
                    print(f"  Kept (trivial):     {rel_src}")
                continue

            # Compile
            base = os.path.splitext(fname)[0]
            try:
                _cython_compile_one(toolchain, full_src, target_root,
                                    base, verbose=verbose)
                compiled += 1
            except RuntimeError as e:
                print(f"FAILED to compile {rel_src}:\n{e}")
                raise

    print(f"\nCython summary: {compiled} compiled, {kept} kept as entry-points, "
          f"{skipped_trivial} trivial __init__.py copied as-is.")
    return compiled, kept, skipped_trivial


# ---------------------------------------------------------------------------
# Legacy .pyc compile path (unchanged from the original)
# ---------------------------------------------------------------------------

def pyc_compile_tree(src_dir, dist_dir, skip_dirs):
    """Compile .py -> .pyc, then mirror clean-named .pyc files into dist_dir."""
    print(f"Compiling source in {src_dir} (bytecode mode)...")
    compileall.compile_dir(src_dir, force=True, quiet=True)

    abs_dist = os.path.abspath(dist_dir)
    count = 0
    for root, dirs, files in os.walk(src_dir):
        if os.path.abspath(root).startswith(abs_dist):
            continue
        dirs[:] = [d for d in dirs if d == '__pycache__' or d not in skip_dirs]
        if '__pycache__' in dirs:
            cache_path = os.path.join(root, '__pycache__')
            rel_path = os.path.relpath(root, src_dir)
            target_folder = os.path.join(dist_dir, rel_path)
            os.makedirs(target_folder, exist_ok=True)

            for filename in os.listdir(cache_path):
                match = re.match(r"(.+)\.cpython-\d+\.pyc", filename)
                if match:
                    clean_name = f"{match.group(1)}.pyc"
                    shutil.copy2(os.path.join(cache_path, filename),
                                 os.path.join(target_folder, clean_name))
                    print(f"Packaged: {clean_name}")
                    count += 1
    print(f"\npyc summary: {count} bytecode file(s) packaged.")


# ---------------------------------------------------------------------------
# Asset & venv copy + zip pack (shared between modes)
# ---------------------------------------------------------------------------

def copy_matching_assets(src_dir, dist_dir, patterns, skip_dirs):
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
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


def copy_json_sources(src_dir, dist_dir, json_sources):
    for jx in json_sources:
        json_src = os.path.join(src_dir, jx)
        if os.path.exists(json_src):
            json_dist = os.path.join(dist_dir, jx)
            if os.path.exists(json_dist):
                shutil.rmtree(json_dist)
            shutil.copytree(json_src, json_dist)
            print(f"Copied JSON configuration files [{jx}].")


def copy_venv(src_dir, dist_dir):
    venv_src = os.path.join(src_dir, '.venv')
    if os.path.exists(venv_src):
        venv_dist = os.path.join(dist_dir, '.venv')
        if os.path.exists(venv_dist):
            shutil.rmtree(venv_dist)
        shutil.copytree(venv_src, venv_dist, symlinks=True)
        print("Copied virtual environment.")
    else:
        print("No .venv to copy (skipping).")


def copy_source_trees(src_dir, dist_dir, copy_trees, skip_dirs):
    ignore = shutil.ignore_patterns(*skip_dirs)
    for rel_tree in copy_trees:
        src_tree = os.path.join(src_dir, rel_tree)
        if not os.path.isdir(src_tree):
            print(f"Source tree [{rel_tree}] not found (skipping).")
            continue

        dst_tree = os.path.join(dist_dir, rel_tree)
        if os.path.exists(dst_tree):
            shutil.rmtree(dst_tree)
        shutil.copytree(src_tree, dst_tree, ignore=ignore)
        print(f"Copied source tree [{rel_tree}].")


def zip_dist(dist_dir, output_zip):
    if os.path.exists(output_zip):
        os.remove(output_zip)
    abs_dist = os.path.abspath(dist_dir)
    abs_out = os.path.abspath(output_zip)
    with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for root, _, files in os.walk(dist_dir):
            for f in files:
                full = os.path.join(root, f)
                if os.path.abspath(full) == abs_out:
                    continue
                arcname = os.path.relpath(full, abs_dist)
                zf.write(full, arcname)
    size_mb = os.path.getsize(output_zip) / (1024 * 1024)
    print(f"Packed distribution -> {output_zip} ({size_mb:.2f} MB)")


# ---------------------------------------------------------------------------
# Top-level orchestrator
# ---------------------------------------------------------------------------

def build_compiled_dist(src_dir, dist_dir, output_zip=None,
                        mode='cython',
                        asset_patterns=None, skip_dirs=None,
                        json_sources=None, copy_venv_flag=True,
                        keep_patterns=None, copy_trees=None, verbose=False):
    asset_patterns = asset_patterns or DEFAULT_ASSET_PATTERNS
    skip_dirs = skip_dirs or DEFAULT_SKIP_DIRS
    json_sources = json_sources if json_sources is not None else DEFAULT_JSON_SOURCES
    keep_patterns = keep_patterns or DEFAULT_KEEP_PY
    copy_trees = copy_trees if copy_trees is not None else DEFAULT_COPY_TREES

    if os.path.exists(dist_dir):
        shutil.rmtree(dist_dir)
    os.makedirs(dist_dir)

    if mode == 'cython':
        cython_compile_tree(src_dir, dist_dir, skip_dirs, keep_patterns,
                            verbose=verbose)
    elif mode == 'pyc':
        pyc_compile_tree(src_dir, dist_dir, skip_dirs)
    else:
        raise ValueError(f"Unknown compile mode: {mode!r}. Use 'cython' or 'pyc'.")

    copy_json_sources(src_dir, dist_dir, json_sources)
    copy_source_trees(src_dir, dist_dir, copy_trees, skip_dirs)
    copy_matching_assets(src_dir, dist_dir, asset_patterns, skip_dirs)

    if copy_venv_flag:
        copy_venv(src_dir, dist_dir)

    if output_zip:
        zip_dist(dist_dir, output_zip)

    return dist_dir, output_zip


def _parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Build a compiled, zipped distribution of the project. "
                    "Default mode is Cython (produces native .so files that "
                    "resist reverse engineering).")
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
    p.add_argument('--verbose', '-v', action='store_true',
                   help="Verbose: print every file as it is compiled.")

    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--use-cython', dest='mode', action='store_const',
                      const='cython', default='cython',
                      help="Compile .py -> .so via Cython (DEFAULT). "
                           "Resists reverse engineering.")
    mode.add_argument('--use-pyc', dest='mode', action='store_const',
                      const='pyc',
                      help="Legacy mode: compile .py -> .pyc bytecode. "
                           "Faster build, but trivially decompiled.")

    p.add_argument('--keep-py', action='append', default=None, metavar='PATTERN',
                   help="Glob pattern for files to leave as .py (NOT compiled). "
                        "Repeatable. Defaults: " + ', '.join(DEFAULT_KEEP_PY))
    return p.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv)
    output_zip = None if args.no_zip or not args.output else args.output

    keep_patterns = args.keep_py if args.keep_py is not None else DEFAULT_KEEP_PY

    print(f"Mode:        {args.mode}")
    print(f"Source:      {os.path.abspath(args.source)}")
    print(f"Dist:        {os.path.abspath(args.dist)}")
    print(f"Output zip:  {output_zip or '(none)'}")
    if args.mode == 'cython':
        print(f"Keep as .py: {keep_patterns}")
    print()

    try:
        dist_dir, zip_path = build_compiled_dist(
            src_dir=args.source,
            dist_dir=args.dist,
            output_zip=output_zip,
            mode=args.mode,
            copy_venv_flag=not args.no_venv,
            keep_patterns=keep_patterns,
            verbose=args.verbose,
        )
    except RuntimeError as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        return 2

    print(f"\nBuild complete. Folder: {dist_dir}"
          + (f"  Zip: {zip_path}" if zip_path else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
