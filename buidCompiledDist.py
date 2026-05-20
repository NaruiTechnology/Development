import argparse
import compileall
import fnmatch
import json
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

# Regex used to keep compileall.compile_dir() out of directories that should
# not ship in the dist (virtualenvs, vendored trees, etc.). Matches any path
# segment whose name is in SKIP_DIRS.
SKIP_RX = re.compile(
    r'(^|[\\/])(' + '|'.join(re.escape(d) for d in SKIP_DIRS) + r')([\\/]|$)'
)

JSON_SOURCES = [
    os.path.join('Development', 'GlasgowDataIO', 'Json'),
    os.path.join('Development', 'LoadFPGAImage', 'Json'),
    os.path.join('GlasgowDataIO', 'Json'),
    os.path.join('DistributionDeploy', 'Json'),
]

# Source ionbeam-web tree lives at Development\ionbeam-web. The destination
# inside dist_app.zip is at the root, because the deploy app expects to
# find it at <DeployRoot>\ionbeam-web after extraction (see setupIonbeamWeb
# in DistributionDeploy.json).
IONBEAM_WEB_SOURCE = os.path.join('Development', 'ionbeam-web')
IONBEAM_WEB_DEST = 'ionbeam-web'

# (src_relpath, dst_relpath_in_dist) — trees copied verbatim into dist.
COPY_TREES = [
    (IONBEAM_WEB_SOURCE, IONBEAM_WEB_DEST),
]

DEPLOY_WORKFLOW_SOURCE = os.path.join('DeployWorkSpace', 'Development', 'DistributionDeploy')
DEPLOY_WORKFLOW_TARGET = os.path.join('Development', 'DistributionDeploy')
DEPLOY_WORKFLOW_SKIP = [
    '__pycache__',
    'dist_app',
    'dist_app.zip',
    'dist_app_raw.zip',
]
DEFAULT_DEPLOY_WORKSPACE = os.path.join('Development', 'DeployWorkSpace')
DEFAULT_DEPLOY_WORKSPACE_ZIP = os.path.join('Development', 'DeployWorkSpace.zip')
ONE_CLICK_DEPLOY_BAT = 'OneKeyDeploy.bat'

# Path (relative to the workspace root) of the JSON config that tells us where
# dist_app.zip should be staged inside the workspace before zipping.
WORKSPACE_DEPLOY_JSON = os.path.join(
    'Development', 'DistributionDeploy', 'Json', 'DistributionDeploy.json'
)
# Key inside that JSON whose value is the target folder for dist_app.zip.
UNZIP_DISTRIBUTION_KEY = 'unzipDistribution'


def _is_inside(path, parent):
    path = os.path.abspath(path)
    parent = os.path.abspath(parent)
    try:
        return os.path.commonpath([path, parent]) == parent
    except ValueError:
        return False


def _target_folder(dist_dir, rel_path):
    return dist_dir if rel_path == os.curdir else os.path.join(dist_dir, rel_path)


def _remove_tree(path):
    def make_writable(func, target, _exc_info):
        try:
            os.chmod(target, 0o700)
        except OSError:
            pass
        func(target)

    if os.path.exists(path):
        shutil.rmtree(path, onerror=make_writable)


def cleanup_pycache_dirs(root_dir):
    skip = {
        '.git',
        '.venv',
        'node_modules',
        'dist_app',
        'dist_app_raw',
    }
    removed = 0
    for root, dirs, _files in os.walk(root_dir):
        dirs[:] = [d for d in dirs if d not in skip]
        for dirname in list(dirs):
            if dirname == '__pycache__':
                _remove_tree(os.path.join(root, dirname))
                dirs.remove(dirname)
                removed += 1

    if removed:
        print(f"Removed generated __pycache__ folders: {removed}")


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
    for src_rel, dst_rel in COPY_TREES:
        src_tree = os.path.join(src_dir, src_rel)
        if not os.path.isdir(src_tree):
            continue
        dst_tree = os.path.join(dist_dir, dst_rel)
        if os.path.exists(dst_tree):
            _remove_tree(dst_tree)
        shutil.copytree(src_tree, dst_tree)
        if src_rel == dst_rel:
            print(f"Copied source tree: {os.path.normpath(src_rel)}")
        else:
            print(
                f"Copied source tree: {os.path.normpath(src_rel)} -> "
                f"{os.path.normpath(dst_rel)}"
            )


def copy_tree_exact(src_tree, dst_tree, label):
    if not os.path.isdir(src_tree):
        raise FileNotFoundError(f"{label} source tree not found: {src_tree}")
    if os.path.exists(dst_tree):
        _remove_tree(dst_tree)
    shutil.copytree(src_tree, dst_tree)
    print(f"Copied {label}: {os.path.normpath(src_tree)} -> {os.path.normpath(dst_tree)}")


def copy_deploy_workflow(src_dir, dist_dir):
    workflow_src = os.path.join(src_dir, DEPLOY_WORKFLOW_SOURCE)
    if not os.path.isdir(workflow_src):
        return

    workflow_dst = os.path.join(dist_dir, DEPLOY_WORKFLOW_TARGET)
    if os.path.exists(workflow_dst):
        _remove_tree(workflow_dst)
    shutil.copytree(
        workflow_src,
        workflow_dst,
        ignore=shutil.ignore_patterns(*DEPLOY_WORKFLOW_SKIP),
    )
    print(
        "Copied deploy workflow: {} -> {}".format(
            os.path.normpath(DEPLOY_WORKFLOW_SOURCE),
            os.path.normpath(DEPLOY_WORKFLOW_TARGET),
        )
    )


def zip_folder(folder, output_zip):
    output_dir = os.path.dirname(os.path.abspath(output_zip))
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    if os.path.exists(output_zip):
        os.remove(output_zip)

    abs_folder = os.path.abspath(folder)
    abs_output = os.path.abspath(output_zip)
    base_parent = os.path.dirname(abs_folder)
    with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for root, dirs, files in os.walk(abs_folder):
            dirs[:] = [d for d in dirs if d not in {'__pycache__', 'dist_app'}]
            for dirname in dirs:
                src_dir = os.path.join(root, dirname)
                archive.write(src_dir, os.path.relpath(src_dir, base_parent))
            for filename in files:
                src_file = os.path.join(root, filename)
                if os.path.abspath(src_file) == abs_output:
                    continue
                archive.write(src_file, os.path.relpath(src_file, base_parent))

    size_mb = os.path.getsize(output_zip) / (1024 * 1024)
    print(f"Workspace archive created successfully: {output_zip} ({size_mb:.2f} MB)")


def write_one_click_deploy_launcher(workspace_dir, dist_zip_relpath='dist_app.zip'):
    launcher_path = os.path.join(workspace_dir, ONE_CLICK_DEPLOY_BAT)
    # Task 3: Every path the launcher touches is anchored to %~dp0 (the
    # folder the .bat itself lives in), so the script works regardless of
    # where the user extracts DeployWorkSpace.zip. No developer-machine
    # paths are baked into the launcher.
    # The dist_zip path is whatever 'unzipDistribution' (in
    # DistributionDeploy.json) resolved to, so the .bat's diagnostic check
    # points at the same location the deploy app will look in.
    dist_zip_winpath = dist_zip_relpath.replace('/', '\\')
    launcher = r'''@echo off
setlocal
title IobeamTech One-Key Deploy

cd /d "%~dp0"
echo Running one-key deploy from: %~dp0

set "APP=%~dp0Development\DistributionDeploy\distributionDeployApp.py"
set "CONFIG=%~dp0Development\DistributionDeploy\Json\DistributionDeploy.json"
set "DIST_ZIP=%~dp0__DIST_ZIP_RELPATH__"

if not exist "%APP%" (
    echo Deploy entrypoint not found:
    echo   "%APP%"
    pause
    exit /b 1
)

if not exist "%CONFIG%" (
    echo Deploy config not found:
    echo   "%CONFIG%"
    pause
    exit /b 1
)

if not exist "%DIST_ZIP%" (
    echo Warning: dist archive not found at the expected location:
    echo   "%DIST_ZIP%"
    echo The deploy app may fail if it expects this file.
    echo.
)

if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON=%~dp0.venv\Scripts\python.exe"
    goto run_deploy
)

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    py -3 "%APP%" -j "%CONFIG%" %*
    set "DEPLOY_EXIT=%ERRORLEVEL%"
    goto done
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    python "%APP%" -j "%CONFIG%" %*
    set "DEPLOY_EXIT=%ERRORLEVEL%"
    goto done
)

echo Python was not found on PATH. Install Python 3 or run from a shell that has Python available.
pause
exit /b 1

:run_deploy
"%PYTHON%" "%APP%" -j "%CONFIG%" %*
set "DEPLOY_EXIT=%ERRORLEVEL%"

:done
echo.
if "%DEPLOY_EXIT%"=="0" (
    echo Deploy workflow completed successfully.
) else (
    echo Deploy workflow failed with exit code %DEPLOY_EXIT%.
)
pause
exit /b %DEPLOY_EXIT%
'''.replace('__DIST_ZIP_RELPATH__', dist_zip_winpath)
    with open(launcher_path, 'w', newline='\r\n') as f:
        f.write(launcher)
    print(f"Wrote one-key deploy launcher: {launcher_path}")


def _resolve_unzip_distribution_relpath(workspace_dir):
    """Read DistributionDeploy.json and return the relative folder (under the
    workspace root) where dist_app.zip should be staged.

    Reads DistributionDeploy.json, walks the Actions[] list, finds the entry
    whose key is 'unzipDistribution', and pulls the path from
    actionData.zip — e.g. ".\\Development\\DistributionDeploy\\dist_app.zip".

    Returns the folder portion only (without the filename), forward-slashed
    and relative to the workspace root, e.g. 'Development/DistributionDeploy'.
    Returns '' on any failure (with a warning) so the caller falls back to
    the workspace root.
    """
    config_path = os.path.join(workspace_dir, WORKSPACE_DEPLOY_JSON)
    if not os.path.isfile(config_path):
        print(
            f"Warning: {WORKSPACE_DEPLOY_JSON} not found at {config_path}; "
            f"placing dist archive at workspace root."
        )
        return ''

    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        print(
            f"Warning: failed to read {config_path}: {exc}; "
            f"placing dist archive at workspace root."
        )
        return ''

    zip_value = None
    for entry in config.get('Actions', []) or []:
        if isinstance(entry, dict) and UNZIP_DISTRIBUTION_KEY in entry:
            action = entry[UNZIP_DISTRIBUTION_KEY]
            if isinstance(action, dict):
                data = action.get('actionData')
                if isinstance(data, dict):
                    zip_value = data.get('zip')
            break

    if not isinstance(zip_value, str) or not zip_value.strip():
        print(
            f"Warning: '{UNZIP_DISTRIBUTION_KEY}.actionData.zip' not found "
            f"in {config_path}; placing dist archive at workspace root."
        )
        return ''

    # Normalise separators, drop leading './' and any leading workspace-folder
    # prefix so the path is relative to workspace_dir regardless of how the
    # JSON spells it. Then drop the filename component — the caller already
    # uses os.path.basename(dist_zip) for the leaf name.
    normalised = zip_value.replace('\\', '/').strip()
    parts = [p for p in normalised.split('/') if p and p != '.']
    workspace_name = os.path.basename(os.path.abspath(workspace_dir))
    if parts and parts[0] == workspace_name:
        parts = parts[1:]
    folder_parts = parts[:-1] if parts else []
    return '/'.join(folder_parts)


def package_deploy_workspace(src_dir, dist_zip, workspace_dir, workspace_zip):
    workspace_dir = os.path.abspath(workspace_dir)
    dist_zip = os.path.abspath(dist_zip)
    workspace_zip = os.path.abspath(workspace_zip)

    if not os.path.isdir(workspace_dir):
        print(
            f"Skipping DeployWorkSpace packaging (folder not found): {workspace_dir}"
        )
        # The dist archive was only an intermediate for the workspace flow.
        # If the workspace isn't there, the archive has nowhere useful to go;
        # remove it instead of leaving a stale artifact at the project root.
        if os.path.isfile(dist_zip):
            os.remove(dist_zip)
            print(f"Removed orphan dist archive: {dist_zip}")
        return
    if not os.path.isfile(dist_zip):
        raise FileNotFoundError(f"dist_app.zip not found: {dist_zip}")

    # Task 1: stage dist_app.zip at the folder named by 'unzipDistribution'
    # in DistributionDeploy.json (so the deploy app finds it where it expects).
    dist_rel_folder = _resolve_unzip_distribution_relpath(workspace_dir)
    target_folder = (
        os.path.join(workspace_dir, *dist_rel_folder.split('/'))
        if dist_rel_folder else workspace_dir
    )
    os.makedirs(target_folder, exist_ok=True)

    embedded_zip = os.path.join(target_folder, os.path.basename(dist_zip))
    if os.path.abspath(embedded_zip) != dist_zip:
        if os.path.exists(embedded_zip):
            os.remove(embedded_zip)
        shutil.move(dist_zip, embedded_zip)
        print(f"Moved dist archive into workspace: {embedded_zip}")
    dist_rel_for_launcher = (
        f"{dist_rel_folder}/{os.path.basename(dist_zip)}" if dist_rel_folder
        else os.path.basename(dist_zip)
    )

    copy_tree_exact(
        os.path.join(src_dir, IONBEAM_WEB_SOURCE),
        os.path.join(workspace_dir, IONBEAM_WEB_DEST),
        'DeployWorkSpace ionbeam-web tree',
    )
    write_one_click_deploy_launcher(workspace_dir, dist_rel_for_launcher)
    zip_folder(workspace_dir, workspace_zip)

    # Task 2: after DeployWorkSpace.zip is built, remove the staged
    # dist_app.zip from inside the workspace folder. It already lives inside
    # the final zip — leaving it on disk just clutters the source tree.
    if os.path.isfile(embedded_zip):
        os.remove(embedded_zip)
        print(f"Removed staged dist archive after zipping: {embedded_zip}")


def zip_dist(dist_dir, output_zip):
    output_dir = os.path.dirname(os.path.abspath(output_zip))
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    if os.path.exists(output_zip):
        os.remove(output_zip)

    abs_dist = os.path.abspath(dist_dir)
    abs_output = os.path.abspath(output_zip)
    with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for root, dirs, files in os.walk(dist_dir):
            for dirname in dirs:
                src_dir = os.path.join(root, dirname)
                archive.write(src_dir, os.path.relpath(src_dir, abs_dist))
            for filename in files:
                src_file = os.path.join(root, filename)
                if os.path.abspath(src_file) == abs_output:
                    continue
                archive.write(src_file, os.path.relpath(src_file, abs_dist))

    size_mb = os.path.getsize(output_zip) / (1024 * 1024)
    print(f"Archive created successfully: {output_zip} ({size_mb:.2f} MB)")


def build_compiled_dist(src_dir, dist_dir, output_zip='dist_app.zip',
                        deliver_raw=False, clean=True,
                        deploy_workspace=None, deploy_workspace_zip=None):
    src_dir = os.path.abspath(src_dir)
    dist_dir = os.path.abspath(dist_dir)
    output_zip = os.path.abspath(output_zip) if output_zip else None

    if output_zip and _is_inside(output_zip, dist_dir):
        raise ValueError("output zip must be outside the dist directory")

    # 1. Byte-compile all .py files to __pycache__ (skip in raw mode).
    if not deliver_raw:
        print(f"Compiling source in {src_dir} to .pyc...")
        compileall.compile_dir(
            src_dir, force=True, quiet=True, legacy=False, rx=SKIP_RX
        )
    else:
        print("Raw delivery mode: skipping byte-compilation.")

    # 2. Refresh the dist folder.
    if os.path.exists(dist_dir):
        _remove_tree(dist_dir)
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

    # 6. Copy the deployment workflow and JSON config.
    copy_deploy_workflow(src_dir, dist_dir)

    # 7. Copy assets (includes README.md).
    copy_matching_assets(src_dir, dist_dir, ASSET_PATTERNS)

    # 8. Zip the output content.
    if output_zip:
        print(f"\nCreating archive {output_zip}...")
        zip_dist(dist_dir, output_zip)

    # 9. Final cleanup.
    if clean:
        print(f"Removing temporary build folder {dist_dir}...")
        _remove_tree(dist_dir)

    cleanup_pycache_dirs(src_dir)

    if output_zip and deploy_workspace and deploy_workspace_zip:
        package_deploy_workspace(
            src_dir,
            output_zip,
            deploy_workspace,
            deploy_workspace_zip,
        )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='Deploy source code.')
    parser.add_argument('--source', default='.', help="Source folder to package.")
    parser.add_argument('--dist', default=os.path.join('Development', 'dist_app'),
                        help="Temporary dist folder.")
    parser.add_argument('--output', default=os.path.join('Development', 'dist_app.zip'),
                        help="Output zip path.")
    parser.add_argument('-r', '--raw', action='store_true', dest='raw',
                        help="Deliver raw python code (skip byte-compilation).")
    parser.add_argument('--keep-dist', action='store_true',
                        help="Keep the temporary dist folder after zipping.")
    parser.add_argument('--deploy-workspace',
                        default=DEFAULT_DEPLOY_WORKSPACE,
                        help="DeployWorkSpace folder to refresh and zip.")
    parser.add_argument('--deploy-workspace-zip',
                        default=DEFAULT_DEPLOY_WORKSPACE_ZIP,
                        help="Output zip path for the whole DeployWorkSpace folder.")
    parser.add_argument('--no-deploy-workspace-zip', action='store_true',
                        help="Skip refreshing and zipping DeployWorkSpace after dist_app.zip.")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    build_compiled_dist(
        args.source,
        args.dist,
        output_zip=args.output,
        deliver_raw=bool(args.raw),
        clean=not args.keep_dist,
        deploy_workspace=None if args.no_deploy_workspace_zip else args.deploy_workspace,
        deploy_workspace_zip=None if args.no_deploy_workspace_zip else args.deploy_workspace_zip,
    )
    mode = "raw source" if args.raw else "compiled .pyc"
    workspace_zip_exists = (
        not args.no_deploy_workspace_zip
        and args.deploy_workspace_zip
        and os.path.isfile(args.deploy_workspace_zip)
    )
    if workspace_zip_exists:
        print(
            f"\nBuild complete ({mode})! The one-key deploy package is "
            f"'{args.deploy_workspace_zip}'."
        )
    else:
        print(f"\nBuild complete ({mode})! The final package is '{args.output}'.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"\nBuild failed with error: {e}", file=sys.stderr)
        sys.exit(1)