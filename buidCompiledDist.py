import os
import sys
import shutil
import compileall
import re
import fnmatch
import argparse
import json
from datetime import datetime

try:
    import tomllib
except ImportError:  # pragma: no cover - Python 3.10 deploy builder fallback
    tomllib = None


REQUIRED_GLASGOW_RUNTIME_PACKAGES = ('gpiozero', 'httpx', 'redis')

# Files (by name or glob) to copy verbatim into dist
ASSET_PATTERNS = [
    '*.ihex', '*.toml', 'requirements.txt', 'README.md', '*.service', '*.env.example', '*.sh'
]

# Files to exclude from any copied tree or asset sweep.
EXCLUDE_PATTERNS = ['*.log']

# Directories to skip when walking the source tree for the per-file passes
# (.py/.pyc packaging and ASSET_PATTERNS scan). Non-Python source projects
# listed in COPY_TREES are excluded here because they're handled wholesale
# by copy_source_trees().
SKIP_DIRS = {
    '__pycache__',
    '.venv',
    '.git',
    '.agents',
    '.codex',
    '.pytest_cache',
    'dist_app',
    'EsmBeamController',
    'Open-Beam-Interface',
    'DistributionDeploy',
    'DeployWorkSpace',
    'LoadFPGAImage',
}

# Non-Python source trees copied verbatim. Paths are relative to src_dir.
# Anything in here is packaged in full, preserving every file regardless of
# extension (package.json, package-lock.json, tsconfig.json, vite.config.*,
# .env.example, index.html, src/, public/, etc.).
COPY_TREES = [
    os.path.join('Development', 'ionbeam-web'),
    os.path.join('Development', 'IobeamAdmin'),
    os.path.join(
        'Development', 'GlasgowDataIO', 'IobeamControl', 'unittest', 'testData'),
]

# Patterns excluded while copying a tree from COPY_TREES. Keeps the zip
# small by dropping dependency installs and build output -- the deploy
# host will regenerate node_modules via `npm install`.
TREE_COPY_IGNORE = (
    '__pycache__', '.git', '.venv', '.cache', '.pytest_cache',
    'node_modules', 'dist', 'build', '.next', '.turbo', '.env',
    '*.log',
)

STREAM_DATA_JSON = os.path.join(
    'Development', 'GlasgowDataIO', 'Json', 'streamData.json')


def _development_relative_path(src_dir, *parts):
    """Resolve files when invoked from workspace root or Development root."""
    candidates = [
        os.path.join(src_dir, 'Development', *parts),
        os.path.join(src_dir, *parts),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return candidates[0]


def _requirement_names(path):
    names = set()
    with open(path, 'r', encoding='utf-8') as stream:
        for raw_line in stream:
            line = raw_line.split('#', 1)[0].strip()
            if not line or line.startswith(('-', 'git+')):
                continue
            match = re.match(r'([A-Za-z0-9_.-]+)', line)
            if match:
                names.add(match.group(1).lower().replace('_', '-'))
    return names


def validate_glasgow_runtime_dependencies(src_dir):
    """Fail the distribution build when HA runtime clients are omitted."""
    requirements_path = _development_relative_path(
        src_dir, 'glasgow_service', 'requirements.txt')
    pyproject_path = _development_relative_path(
        src_dir, 'glasgow_service', 'pyproject.toml')
    missing_files = [
        path for path in (requirements_path, pyproject_path)
        if not os.path.isfile(path)
    ]
    if missing_files:
        raise FileNotFoundError(
            'Missing Glasgow dependency manifest(s): ' + ', '.join(missing_files))

    requirement_names = _requirement_names(requirements_path)
    missing_requirements = sorted(
        set(REQUIRED_GLASGOW_RUNTIME_PACKAGES) - requirement_names)
    if missing_requirements:
        raise ValueError(
            'glasgow_service/requirements.txt is missing: ' +
            ', '.join(missing_requirements))

    if tomllib is not None:
        with open(pyproject_path, 'rb') as stream:
            dependencies = tomllib.load(stream).get('project', {}).get(
                'dependencies', [])
    else:
        # The deployed project still supports Python 3.10. Parse only quoted
        # entries inside the project dependencies array rather than requiring
        # the third-party ``tomli`` package in the build environment.
        with open(pyproject_path, 'r', encoding='utf-8') as stream:
            pyproject_text = stream.read()
        match = re.search(
            r'(?ms)^dependencies\s*=\s*\[(.*?)^\]', pyproject_text)
        dependencies = (
            re.findall(r'["\']([^"\']+)["\']', match.group(1))
            if match else []
        )
    dependency_names = {
        re.match(r'([A-Za-z0-9_.-]+)', dependency).group(1).lower().replace('_', '-')
        for dependency in dependencies
        if re.match(r'([A-Za-z0-9_.-]+)', dependency)
    }
    missing_metadata = sorted(
        set(REQUIRED_GLASGOW_RUNTIME_PACKAGES) - dependency_names)
    if missing_metadata:
        raise ValueError(
            'glasgow_service/pyproject.toml is missing: ' +
            ', '.join(missing_metadata))
    print('Validated Glasgow runtime dependencies: ' +
          ', '.join(REQUIRED_GLASGOW_RUNTIME_PACKAGES))


def copy_source_trees(src_dir, dist_dir, trees):
    """Copy listed source trees verbatim from src_dir into dist_dir.

    Skips dependency installs and build artifacts (see TREE_COPY_IGNORE)
    so the resulting zip stays small. All other files in the tree --
    including non-Python ones like package.json, tsconfig.json,
    vite.config.*, .env.example -- are preserved.
    """
    for rel_tree in trees:
        src_tree = os.path.join(src_dir, rel_tree)
        if not os.path.isdir(src_tree):
            print(f"Source tree [{rel_tree}] not found (skipping).")
            continue
        dst_tree = os.path.join(dist_dir, rel_tree)
        shutil.copytree(
            src_tree,
            dst_tree,
            ignore=_tree_copy_ignore_for(rel_tree),
            dirs_exist_ok=True,
        )
        print(f"Copied source tree: {rel_tree}")


def _tree_copy_ignore_for(rel_tree):
    """Return a per-tree ignore callback.

    The ionbeam-web tree should keep backend/deploy intact so the dist zip
    carries the full backend subtree, but still skip the top-level frontend
    deploy assets that are not needed in the packaged app.
    """
    base_ignore = set(TREE_COPY_IGNORE)
    if os.path.normpath(rel_tree) == os.path.join('Development', 'ionbeam-web'):
        def ignore(dirpath, names):
            ignored = set()
            rel_dir = os.path.normpath(os.path.relpath(dirpath, rel_tree))
            for name in names:
                if name in base_ignore:
                    ignored.add(name)
                    continue
                if name == 'deploy':
                    if rel_dir != 'backend':
                        ignored.add(name)
            return ignored

        return ignore

    return shutil.ignore_patterns(*base_ignore)


def copy_preserved_files(src_dir, dist_dir, file_pairs):
    """Copy specific files that are intentionally excluded from tree ignores."""
    for rel_src, rel_dst in file_pairs:
        src_file = os.path.join(src_dir, rel_src)
        if not os.path.isfile(src_file):
            print(f"Preserved file not found (skipping): {rel_src}")
            continue
        dest_file = os.path.join(dist_dir, rel_dst)
        os.makedirs(os.path.dirname(dest_file), exist_ok=True)
        shutil.copy2(src_file, dest_file)
        print(f"Copied preserved file: {rel_dst}")


def copy_matching_assets(src_dir, dist_dir, patterns):
    """Walk src_dir and copy any files matching patterns into dist_dir."""
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        # Prune skipped dirs in-place
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

        if os.path.abspath(root).startswith(abs_dist):
            continue

        for filename in files:
            if any(fnmatch.fnmatch(filename, pat) for pat in EXCLUDE_PATTERNS):
                continue
            if any(fnmatch.fnmatch(filename, pat) for pat in patterns):
                rel_path = os.path.relpath(root, src_dir)
                target_folder = os.path.join(dist_dir, rel_path)
                os.makedirs(target_folder, exist_ok=True)
                src_file = os.path.join(root, filename)
                dest_file = os.path.join(target_folder, filename)
                shutil.copy2(src_file, dest_file)
                print(f"Copied asset: {os.path.normpath(os.path.join(rel_path, filename))}")

def build_compiled_dist(src_dir, dist_dir, deliver_raw=False):
    validate_glasgow_runtime_dependencies(src_dir)
    # 1. Byte-compile all .py files to __pycache__ (skip in raw mode)
    if not deliver_raw:
        print(f"Compiling source in {src_dir} to .pyc...")
        compileall.compile_dir(src_dir, force=True, quiet=True, legacy=False)
    else:
        print("Raw delivery mode: skipping byte-compilation.")

    # 2. Refresh the dist folder
    if os.path.exists(dist_dir):
        shutil.rmtree(dist_dir, ignore_errors=True) 
    os.makedirs(dist_dir, exist_ok=True)

    # 2.5. Copy non-Python source trees wholesale (Node projects, etc.)
    # Done before the .py walk so SKIP_DIRS cleanly excludes these paths
    # from per-file processing.
    copy_source_trees(src_dir, dist_dir, COPY_TREES)
    copy_preserved_files(src_dir, dist_dir, [
        (
            os.path.join('Development', 'ionbeam-web', 'backend', '.env'),
            os.path.join('Development', 'ionbeam-web', 'backend', '.env'),
        ),
        (
            os.path.join('Development', 'ionbeam-web', 'deploy', 'ionbeam-web.service'),
            os.path.join('Development', 'ionbeam-web', 'deploy', 'ionbeam-web.service'),
        ),
        (
            os.path.join('Development', 'ionbeam-web', 'deploy', 'mobility-only-bootstrap.sh'),
            os.path.join('Development', 'ionbeam-web', 'deploy', 'mobility-only-bootstrap.sh'),
        ),
        (
            os.path.join('Development', 'ionbeam-web', 'deploy', 'remote-vm.md'),
            os.path.join('Development', 'ionbeam-web', 'deploy', 'remote-vm.md'),
        ),
    ])

    # 3. Package source files: raw .py files OR extracted/flattened .pyc files
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        if os.path.abspath(root).startswith(abs_dist):
            dirs[:] = []  # don't descend into the dist tree
            continue

        rel_path = os.path.relpath(root, src_dir)

        if deliver_raw:
            # Copy .py source files directly, preserving directory structure
            py_files = [f for f in files if f.endswith('.py')]
            if py_files:
                target_folder = os.path.join(dist_dir, rel_path)
                os.makedirs(target_folder, exist_ok=True)
                for filename in py_files:
                    src_file = os.path.join(root, filename)
                    dest_file = os.path.join(target_folder, filename)
                    shutil.copy2(src_file, dest_file)
                    print(f"Packaged (raw): {os.path.normpath(os.path.join(rel_path, filename))}")
        else:
            # Extract .pyc files from __pycache__ and flatten names
            if '__pycache__' in dirs:
                cache_path = os.path.join(root, '__pycache__')
                target_folder = os.path.join(dist_dir, rel_path)
                os.makedirs(target_folder, exist_ok=True)

                for filename in os.listdir(cache_path):
                    match = re.match(r"(.+)\.cpython-\d+\.pyc", filename)
                    if match:
                        clean_name = f"{match.group(1)}.pyc"
                        src_file = os.path.join(cache_path, filename)
                        dest_file = os.path.join(target_folder, clean_name)
                        shutil.copy2(src_file, dest_file)
                        print(f"Packaged: {os.path.join(rel_path, clean_name)}")

        # Prune dirs for the next iteration
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

    # 4. Copy specific configuration and database setup folders
    json_sources = [
        r'Development/GlasgowDataIO/Json',
        r'Development/LoadFPGAImage/Json',
        r'Development/IobeamAdmin/Json',
    ]
    for jx in json_sources:
        json_src = os.path.join(src_dir, jx)
        if os.path.exists(json_src):
            json_dist = os.path.join(dist_dir, jx)
            shutil.copytree(json_src, json_dist, dirs_exist_ok=True)
            print(f"Copied JSON folder: {jx}")

    sql_sources = [r'Development/IobeamAdmin/Sql']
    for sx in sql_sources:
        sql_src = os.path.join(src_dir, sx)
        if os.path.exists(sql_src):
            sql_dist = os.path.join(dist_dir, sx)
            shutil.copytree(sql_src, sql_dist, dirs_exist_ok=True)
            print(f"Copied SQL folder: {sx}")

    # 5. Copy assets (includes README.md)
    copy_matching_assets(src_dir, dist_dir, ASSET_PATTERNS)

    # 6. Zip the output content (distinct names so raw/compiled don't overwrite)
    zip_name = "dist_app_raw" if deliver_raw else "dist_app"
    print(f"\nCreating archive {zip_name}.zip...")
    if os.path.exists(f"{zip_name}.zip"):
        os.remove(f"{zip_name}.zip")
    shutil.make_archive(zip_name, 'zip', dist_dir)
    print(f"Archive created successfully.")

    # 7. Final Cleanup: Remove the dist_dir tree
    print(f"Removing temporary build folder {dist_dir}...")
    shutil.rmtree(dist_dir, ignore_errors=True)


def clear_zips_in(folder):
    """Remove every *.zip from folder (non-recursive). Creates folder if missing."""
    os.makedirs(folder, exist_ok=True)
    removed = 0
    for fn in os.listdir(folder):
        if fn.lower().endswith('.zip'):
            path = os.path.join(folder, fn)
            try:
                os.remove(path)
                print(f"Removed existing zip: {path}")
                removed += 1
            except OSError as e:
                print(f"Could not remove {path}: {e}")
    if removed == 0:
        print(f"No existing zips to clear in {folder}.")


def clean_pycache_under(folder):
    """Recursively delete *.pyc files and __pycache__ directories under folder."""
    if not os.path.isdir(folder):
        print(f"Cleanup target not found, skipping: {folder}")
        return
    pyc_count, cache_count = 0, 0
    # topdown=False so we delete inner __pycache__ before walking past them
    for root, dirs, files in os.walk(folder, topdown=False):
        for fn in files:
            if fn.endswith('.pyc'):
                try:
                    os.remove(os.path.join(root, fn))
                    pyc_count += 1
                except OSError as e:
                    print(f"Could not remove {fn}: {e}")
        for d in list(dirs):
            if d == '__pycache__':
                cache_path = os.path.join(root, d)
                shutil.rmtree(cache_path, ignore_errors=True)
                cache_count += 1
    print(f"Cleanup: removed {pyc_count} .pyc file(s) and "
          f"{cache_count} __pycache__ folder(s) under {folder}.")


def stream_data_json_path(src_dir):
    """Return the streamData.json path for either project-root invocation style."""
    candidates = [
        os.path.join(src_dir, STREAM_DATA_JSON),
        os.path.join(src_dir, 'GlasgowDataIO', 'Json', 'streamData.json'),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError(
        "Cannot find streamData.json. Checked: " + ", ".join(candidates))


def version_label_from_stream_data(src_dir):
    """Read Version from streamData.json and format it for archive names."""
    path = stream_data_json_path(src_dir)
    with open(path, 'r', encoding='utf-8') as f:
        version = str(json.load(f).get('Version', '')).strip()

    if not version:
        raise ValueError(f"Missing Version in {path}")

    parts = version.split('.')
    while len(parts) > 2 and parts[-1] == '0':
        parts.pop()
    version = '.'.join(parts)
    safe_version = re.sub(r'[^A-Za-z0-9._-]+', '_', version).strip('._-')
    if not safe_version:
        raise ValueError(f"Version in {path} is not usable for a filename")
    return f"v{safe_version}"


def timestamp_label():
    return datetime.now().strftime('%m%d%y_%H%M')


def zip_folder(folder, archive_base=None):
    """Zip `folder` into <basename>.zip in the current working directory.

    The archive preserves the folder itself as the top-level entry (so
    extracting reproduces the directory rather than spraying its contents
    into the cwd). Returns the archive path.
    """
    folder = os.path.normpath(folder)
    if not os.path.isdir(folder):
        raise FileNotFoundError(f"Cannot zip missing folder: {folder}")
    base = os.path.basename(folder)
    parent = os.path.dirname(folder) or '.'
    archive_base = archive_base or base  # writes <archive_base>.zip in cwd
    if os.path.exists(f"{archive_base}.zip"):
        os.remove(f"{archive_base}.zip")
    print(f"\nCreating workspace archive {archive_base}.zip from {folder}...")
    shutil.make_archive(archive_base, 'zip', root_dir=parent, base_dir=base)
    final_path = os.path.abspath(f"{archive_base}.zip")
    print(f"Workspace archive created: {final_path}")
    return final_path


def post_build_deploy(zip_name, deploy_dir, workspace_dir, workspace_archive_base=None):
    """Post-build pipeline run after a successful build:
       1. clear any existing .zip files from deploy_dir
       2. move <zip_name>.zip into deploy_dir
       3. strip *.pyc and __pycache__ from workspace_dir
       4. zip workspace_dir into <basename>.zip alongside the cwd

    Step 4 picks up the freshly-placed dist zip from step 2 because
    deploy_dir lives inside workspace_dir.
    """
    archive_name = f"{zip_name}.zip"

    # 1. Clear existing zips from the deploy slot
    print(f"\n--- Post-build: clearing zips in {deploy_dir} ---")
    clear_zips_in(deploy_dir)

    # 2. Move freshly built archive into the deploy slot
    if not os.path.isfile(archive_name):
        raise FileNotFoundError(f"Build output not found: {archive_name}")
    moved_path = os.path.join(deploy_dir, archive_name)
    shutil.move(archive_name, moved_path)
    print(f"Moved {archive_name} -> {moved_path}")

    # 3. Strip bytecode droppings from the workspace before zipping it
    print(f"\n--- Post-build: cleaning bytecode under {workspace_dir} ---")
    clean_pycache_under(workspace_dir)

    # 4. Zip the entire workspace for handoff
    return zip_folder(workspace_dir, archive_base=workspace_archive_base)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Deploy source code.')
    parser.add_argument('-r', '--raw', action='store_true', dest='raw',
                        help="Deliver raw python code (skip byte-compilation)", default=False)
    args = parser.parse_args()

    exit_code = 0
    try:
        build_compiled_dist('.', './dist_app', deliver_raw=bool(args.raw))
        mode = "raw source" if args.raw else "compiled .pyc"
        zip_name = "dist_app_raw" if args.raw else "dist_app"
        archive = f"{zip_name}.zip"
        print(f"\nBuild complete ({mode})! The final package is '{archive}'.")

        # Post-build deploy: drop the dist archive into DistributionDeploy,
        # scrub bytecode, then zip the whole DeployWorkSpace for handoff.
        deploy_dir = os.path.join('.', 'Development', 'DeployWorkSpace',
                                  'Development', 'DistributionDeploy')
        workspace_dir = os.path.join('.', 'Development', 'DeployWorkSpace')
        version_label = version_label_from_stream_data('.')
        workspace_archive_base = f"DeployWorkspace_{version_label}_{timestamp_label()}"
        final_archive = post_build_deploy(
            zip_name, deploy_dir, workspace_dir, workspace_archive_base)
        print(f"Final handoff archive: {final_archive}")
        print("\nAll steps complete.")
    except Exception as e:
        print(f"\nBuild failed with error: {e}")
        exit_code = 1

    # Flush so any final output reaches the terminal even if the runner is
    # buffering, then return an explicit code. Some launchers won't release
    # the terminal until the process delivers a definitive exit signal.
    sys.stdout.flush()
    sys.stderr.flush()
    sys.exit(exit_code)
    # If sys.exit still doesn't terminate (i.e. something is blocking
    # interpreter shutdown -- non-daemon thread, lingering subprocess, etc.),
    # uncomment the line below. os._exit skips interpreter cleanup and
    # always terminates immediately. Using it is a diagnostic signal that
    # something else needs investigating.
    # os._exit(exit_code)
