import argparse
import compileall
import fnmatch
import os
import re
import shutil
import sys
import zipfile

# Files (by name or glob) to copy verbatim into dist.
ASSET_PATTERNS = ['*.ihex', 'requirements.txt', 'README.md']

# Directories to skip when walking the source tree.
SKIP_DIRS = {
    '__pycache__',
    '.venv',
    '.git',
    '.pytest_cache',
    'dist_app',
    'EsmBeamController',
    'Open-Beam-Interface',
    'DistributionDeploy',
    'DeployWorkSpace',
    'LoadFPGAImage',
    'node_modules',
}

JSON_SOURCES = [
    os.path.join('Development', 'GlasgowDataIO', 'Json'),
    os.path.join('Development', 'LoadFPGAImage', 'Json'),
    os.path.join('GlasgowDataIO', 'Json'),
    os.path.join('DistributionDeploy', 'Json'),
]

COPY_TREES = [
    'ionbeam-web',
]


def _is_inside(path, parent):
    path = os.path.abspath(path)
    parent = os.path.abspath(parent)
    try:
        return os.path.commonpath([path, parent]) == parent
    except ValueError:
        return False


def _target_folder(dist_dir, rel_path):
    return dist_dir if rel_path == os.curdir else os.path.join(dist_dir, rel_path)


def copy_matching_assets(src_dir, dist_dir, patterns):
    """Walk src_dir and copy any files matching patterns into dist_dir."""
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

        if _is_inside(root, abs_dist):
            dirs[:] = []
            continue

        for filename in files:
            if any(fnmatch.fnmatch(filename, pat) for pat in patterns):
                rel_path = os.path.relpath(root, src_dir)
                target_folder = _target_folder(dist_dir, rel_path)
                os.makedirs(target_folder, exist_ok=True)
                src_file = os.path.join(root, filename)
                dest_file = os.path.join(target_folder, filename)
                shutil.copy2(src_file, dest_file)
                print(f"Copied asset: {os.path.normpath(os.path.join(rel_path, filename))}")


def copy_json_sources(src_dir, dist_dir):
    for rel_json in JSON_SOURCES:
        json_src = os.path.join(src_dir, rel_json)
        if os.path.isdir(json_src):
            json_dist = os.path.join(dist_dir, rel_json)
            if os.path.exists(json_dist):
                shutil.rmtree(json_dist)
            shutil.copytree(json_src, json_dist)
            print(f"Copied JSON folder: {os.path.normpath(rel_json)}")


def copy_source_trees(src_dir, dist_dir):
    ignore = shutil.ignore_patterns(*SKIP_DIRS)
    for rel_tree in COPY_TREES:
        src_tree = os.path.join(src_dir, rel_tree)
        if not os.path.isdir(src_tree):
            continue
        dst_tree = os.path.join(dist_dir, rel_tree)
        if os.path.exists(dst_tree):
            shutil.rmtree(dst_tree)
        shutil.copytree(src_tree, dst_tree, ignore=ignore)
        print(f"Copied source tree: {os.path.normpath(rel_tree)}")


def zip_dist(dist_dir, output_zip):
    if os.path.exists(output_zip):
        os.remove(output_zip)

    abs_dist = os.path.abspath(dist_dir)
    abs_output = os.path.abspath(output_zip)
    with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for root, _, files in os.walk(dist_dir):
            for filename in files:
                src_file = os.path.join(root, filename)
                if os.path.abspath(src_file) == abs_output:
                    continue
                archive.write(src_file, os.path.relpath(src_file, abs_dist))

    size_mb = os.path.getsize(output_zip) / (1024 * 1024)
    print(f"Archive created successfully: {output_zip} ({size_mb:.2f} MB)")


def build_compiled_dist(src_dir, dist_dir, output_zip='dist_app.zip',
                        deliver_raw=False, clean=True):
    src_dir = os.path.abspath(src_dir)
    dist_dir = os.path.abspath(dist_dir)
    output_zip = os.path.abspath(output_zip) if output_zip else None

    if output_zip and _is_inside(output_zip, dist_dir):
        raise ValueError("output zip must be outside the dist directory")

    # 1. Byte-compile all .py files to __pycache__ (skip in raw mode).
    if not deliver_raw:
        print(f"Compiling source in {src_dir} to .pyc...")
        compileall.compile_dir(src_dir, force=True, quiet=True, legacy=False)
    else:
        print("Raw delivery mode: skipping byte-compilation.")

    # 2. Refresh the dist folder.
    if os.path.exists(dist_dir):
        shutil.rmtree(dist_dir, ignore_errors=True)
    os.makedirs(dist_dir, exist_ok=True)

    # 3. Package source files: raw .py files OR extracted/flattened .pyc files.
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        if _is_inside(root, abs_dist):
            dirs[:] = []
            continue

        rel_path = os.path.relpath(root, src_dir)

        if deliver_raw:
            py_files = [f for f in files if f.endswith('.py')]
            if py_files:
                target_folder = _target_folder(dist_dir, rel_path)
                os.makedirs(target_folder, exist_ok=True)
                for filename in py_files:
                    src_file = os.path.join(root, filename)
                    dest_file = os.path.join(target_folder, filename)
                    shutil.copy2(src_file, dest_file)
                    print(f"Packaged (raw): {os.path.normpath(os.path.join(rel_path, filename))}")
        else:
            if '__pycache__' in dirs:
                cache_path = os.path.join(root, '__pycache__')
                target_folder = _target_folder(dist_dir, rel_path)
                os.makedirs(target_folder, exist_ok=True)

                for filename in os.listdir(cache_path):
                    match = re.match(r"(.+)\.cpython-\d+\.pyc", filename)
                    if match:
                        clean_name = f"{match.group(1)}.pyc"
                        src_file = os.path.join(cache_path, filename)
                        dest_file = os.path.join(target_folder, clean_name)
                        shutil.copy2(src_file, dest_file)
                        print(f"Packaged: {os.path.normpath(os.path.join(rel_path, clean_name))}")

        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

    # 4. Copy specific JSON configuration folders.
    copy_json_sources(src_dir, dist_dir)

    # 5. Copy non-Python application source trees.
    copy_source_trees(src_dir, dist_dir)

    # 6. Copy assets (includes README.md).
    copy_matching_assets(src_dir, dist_dir, ASSET_PATTERNS)

    # 7. Zip the output content.
    if output_zip:
        print(f"\nCreating archive {output_zip}...")
        zip_dist(dist_dir, output_zip)

    # 8. Final cleanup.
    if clean:
        print(f"Removing temporary build folder {dist_dir}...")
        shutil.rmtree(dist_dir, ignore_errors=True)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='Deploy source code.')
    parser.add_argument('--source', default='.', help="Source folder to package.")
    parser.add_argument('--dist', default='dist_app', help="Temporary dist folder.")
    parser.add_argument('--output', default='dist_app.zip', help="Output zip path.")
    parser.add_argument('-r', '--raw', action='store_true', dest='raw',
                        help="Deliver raw python code (skip byte-compilation).")
    parser.add_argument('--keep-dist', action='store_true',
                        help="Keep the temporary dist folder after zipping.")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    build_compiled_dist(
        args.source,
        args.dist,
        output_zip=args.output,
        deliver_raw=bool(args.raw),
        clean=not args.keep_dist,
    )
    mode = "raw source" if args.raw else "compiled .pyc"
    print(f"\nBuild complete ({mode})! The final package is '{args.output}'.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"\nBuild failed with error: {e}", file=sys.stderr)
        sys.exit(1)
