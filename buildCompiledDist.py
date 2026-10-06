import os
import sys
import shutil
import py_compile
import re
import fnmatch
import argparse
import importlib.util
import json
from datetime import datetime

try:
    import tomllib
except ImportError:  # pragma: no cover - Python 3.10 deploy builder fallback
    tomllib = None


REQUIRED_GLASGOW_RUNTIME_PACKAGES = ('gpiozero', 'httpx', 'redis')
REQUIRED_SBC_RUNTIME_PACKAGES = ('smbus2', 'pyserial')
REQUIRED_LOCAL_REDIS_APT_PACKAGES = (
    'redis-server', 'redis-sentinel', 'redis-tools')

# Files (by name or glob) to copy verbatim into dist
ASSET_PATTERNS = [
    '*.ihex', '*.toml', 'requirements.txt', 'README.md', '*.service',
    '*.service.in', '*.env.example', '*.env.in', '*.local.env', '*.sh', '*.rules', '*.md'
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
    'node_modules',
    'work',  # QEMU disk/kernel scratch files are not distribution inputs.
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
    'Scripts',
    os.path.join('Development', 'ionbeam-web'),
    os.path.join('Development', 'IobeamAdmin'),
    os.path.join(
        'Development', 'GlasgowDataIO', 'IobeamControl', 'unittest', 'testData'),
]

# Selected source trees have a different required location in the deployed
# topology. manage-local-system.sh walks ../.. from Development/Scripts to
# derive DeployRoot, so moving it to archive-root Scripts breaks path discovery.
COPY_TREE_DESTINATIONS = {
    'Scripts': os.path.join('Development', 'Scripts'),
}

# Patterns excluded while copying a tree from COPY_TREES. Keeps the zip
# small by dropping dependency installs and build output -- the deploy
# host will regenerate node_modules via `npm install`.
TREE_COPY_IGNORE = (
    '__pycache__', '.git', '.venv', '.cache', '.pytest_cache',
    'node_modules', 'dist', 'build', '.next', '.turbo', '.env',
    '*.log', '*.tsbuildinfo',
)

# Non-Python data inside Python packages. The per-file pass above only packages
# .py sources (as .pyc) plus ASSET_PATTERNS, so package data (icons, images,
# translation tables) is copied here, without any .py source.
PACKAGE_DATA_TREES = [
    os.path.join('Development', 'ionbeam-native', 'ionbeam_native', 'resources'),
    os.path.join('Development', 'ionbeam-native', 'ionbeam_native', 'i18n'),
    os.path.join('Development', 'ionbeam-native', 'docs'),
]
PACKAGE_DATA_IGNORE = ('*.py', '*.pyc', '__pycache__', '*.log')

STREAM_DATA_JSON = os.path.join(
    'Development', 'GlasgowDataIO', 'Json', 'streamData.json')

# Shared credential resolver (Development/secretstore). Packaged into the
# distribution like any module, and vendored as source into the
# DeployWorkspace handoff so provisionSecrets can run before dist_app.zip is
# extracted (see DistributionDeploy/secretsSupport.py).
SECRETSTORE_PARTS = ('Development', 'secretstore')
SECRETSTORE_SOURCES = ('__init__.py', '__main__.py')
SECRETSTORE_VENDOR_PARTS = (
    'Development', 'DeployWorkSpace', 'Development', 'DistributionDeploy',
    'vendor', 'secretstore')

# The verifier/producer shared with the deploy workflow (see that file's
# docstring). It lives in the workspace that ships to the deploy host.
MANIFEST_MODULE_PARTS = (
    'DeployWorkSpace', 'Development', 'DistributionDeploy',
    'distributionManifest.py')

# Modules a working deployment cannot do without. Packaged as .pyc when
# compiled and as .py in raw mode, so they are named without an extension.
REQUIRED_DIST_MODULES = (
    # Credential resolver used by the ionbeam-native app and setup scripts.
    'Development/secretstore/__init__',
    'Development/secretstore/__main__',
    'Development/GlasgowDataIO/IobeamControl/IobeamLauncher',
    'Development/GlasgowDataIO/IobeamControl/applet/busController',
    'Development/GlasgowDataIO/IobeamControl/applet/upstreamBusController',
    'Development/GlasgowDataIO/IobeamControl/applet/adcTiming',
    'Development/GlasgowDataIO/IobeamControl/applet/iobeamDataSubtarget',
    'Development/GlasgowDataIO/IobeamControl/applet/commandExecutor',
    # Scan path.  These carry the beam-unblank commands, the IN-endpoint flush
    # (DAC staircase fix) and the [link] timing summary; a distribution built
    # without any of them silently reverts to the blank-image / staircase
    # behaviour, so their absence must fail the build and the deploy verifier.
    'Development/GlasgowDataIO/IobeamControl/applet/DataStreamApplet',
    'Development/GlasgowDataIO/IobeamControl/macros/raster',
    'Development/GlasgowDataIO/IobeamControl/macros/vector',
    'Development/GlasgowDataIO/IobeamControl/transfer/linkStats',
    'Development/glasgow_service/glasgow_service/service',
    'Development/glasgow_service/glasgow_service/device_lock',
    # Native desktop client (ionbeam-native): entry point, persistent Glasgow
    # session and main window. Installed by the installIonbeamNative action.
    'Development/ionbeam-native/ionbeam_native/__main__',
    'Development/ionbeam-native/ionbeam_native/engine/engine',
    'Development/ionbeam-native/ionbeam_native/engine/persistent',
    'Development/ionbeam-native/ionbeam_native/ui/main_window',
    'Development/ionbeam-native/scripts/smoke',
)
REQUIRED_DIST_FILES = (
    'Development/GlasgowDataIO/Json/streamData.json',
    'Development/Scripts/manage-local-system.sh',
    'Development/Scripts/program-fpga-ram.py',
    'Development/ionbeam-web/backend/package.json',
    'Development/IobeamAdmin/Sql/006_equipment_csv_functions.sql',
    'Development/glasgow_service/requirements.txt',
    'Development/requirements.txt',
    'Development/ionbeam-native/requirements.txt',
    'Development/ionbeam-native/scripts/install_linux.sh',
    'Development/ionbeam-native/ionbeam_native/i18n/data/en.json',
    'Development/ionbeam-native/ionbeam_native/resources/images/brand-logo.png',
)


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
        set(REQUIRED_GLASGOW_RUNTIME_PACKAGES + REQUIRED_SBC_RUNTIME_PACKAGES) - requirement_names)
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
    # Hardware drivers are optional project extras, but the deployment installs
    # requirements.txt directly and must receive them before starting services.
    with open(pyproject_path, 'r', encoding='utf-8') as stream:
        metadata = stream.read()
    sbc_extra = re.search(r'(?m)^sbc\s*=\s*\[(.*?)\]', metadata)
    sbc_names = {
        re.match(r'([A-Za-z0-9_.-]+)', value).group(1).lower().replace('_', '-')
        for value in re.findall(r'["\']([^"\']+)["\']', sbc_extra.group(1) if sbc_extra else '')
    }
    missing_sbc = sorted(set(REQUIRED_SBC_RUNTIME_PACKAGES) - sbc_names)
    if missing_sbc:
        raise ValueError('glasgow_service/pyproject.toml SBC extra is missing: ' + ', '.join(missing_sbc))
    print('Validated Glasgow runtime dependencies: ' +
          ', '.join(REQUIRED_GLASGOW_RUNTIME_PACKAGES))


def validate_local_redis_distribution_workflow(src_dir):
    """Require Redis/Sentinel installation to be integrated in the workflow."""
    workflow_root = _development_relative_path(
        src_dir, 'DeployWorkSpace', 'Development', 'DistributionDeploy')
    config_path = os.path.join(workflow_root, 'Json', 'DistributionDeploy.json')
    state_path = os.path.join(
        workflow_root, 'workstates', 'installRedisSentinel_state.py')
    helper_path = _development_relative_path(
        src_dir, 'glasgow_service', 'deploy', 'setup-redis-sentinel.sh')
    missing = [
        path for path in (config_path, state_path, helper_path)
        if not os.path.isfile(path)
    ]
    if missing:
        raise FileNotFoundError(
            'Missing local Redis distribution workflow file(s): ' +
            ', '.join(missing))

    with open(config_path, 'r', encoding='utf-8') as stream:
        config = json.load(stream)
    actions = config.get('Actions', [])
    action_names = [next(iter(action), None) for action in actions]
    try:
        install_index = action_names.index('installRedisSentinel')
        setup_index = action_names.index('setupLocalRedis')
    except ValueError as exc:
        raise ValueError(
            'DistributionDeploy.json must include installRedisSentinel and '
            'setupLocalRedis actions') from exc
    if install_index >= setup_index:
        raise ValueError(
            'installRedisSentinel must run before setupLocalRedis')

    install_action = actions[install_index]['installRedisSentinel']
    packages = install_action.get('actionData', {}).get('aptPackages', [])
    missing_packages = sorted(
        set(REQUIRED_LOCAL_REDIS_APT_PACKAGES) - set(packages))
    if missing_packages:
        raise ValueError(
            'installRedisSentinel is missing apt packages: ' +
            ', '.join(missing_packages))
    print('Validated local Redis/Sentinel distribution workflow: ' +
          ', '.join(REQUIRED_LOCAL_REDIS_APT_PACKAGES))


def resolve_workspace(script_path):
    """Return the workspace root (the parent of ``Development/``).

    Derived from where this script lives, never from the caller's working
    directory: previously, running it from inside ``Development/`` exited 0
    with "Build complete" while silently omitting streamData.json and the
    ionbeam-web backend, and wrote the archive into a stray nested folder.
    """
    development = os.path.dirname(os.path.abspath(script_path))
    if os.path.basename(development) != 'Development':
        raise RuntimeError(
            "buildCompiledDist.py must live in a directory named 'Development' "
            "(found %s); archive paths are rooted at Development/." % development)
    return os.path.dirname(development)


def load_secretstore(src_dir):
    """Load Development/secretstore by path (the build never imports Development)."""
    path = os.path.join(src_dir, *SECRETSTORE_PARTS, '__init__.py')
    if not os.path.isfile(path):
        raise FileNotFoundError('Missing credential module: ' + path)
    spec = importlib.util.spec_from_file_location('secretstore', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_no_literal_credentials(src_dir, root, label):
    """Build gate: refuse to package a tree that contains literal credentials.

    Checks JSON keys such as password/username/token/ConnectionString, URLs
    with an embedded password, and KEY=VALUE secrets in .env / .service
    files. Fix a finding by replacing the value with a ${VAR} placeholder and
    storing the value with `python3 -m secretstore set VAR`.
    """
    problems = load_secretstore(src_dir).scan_tree(root)
    if problems:
        raise RuntimeError(
            '%s contains literal credentials:\n  %s\nReplace them with ${VAR} '
            'placeholders (python3 -m secretstore set VAR stores the value).'
            % (label, '\n  '.join(problems)))
    print(f"Credential scan passed: {label}")


def vendor_secretstore(src_dir):
    """Copy secretstore sources into the DeployWorkspace before it is zipped."""
    source_dir = os.path.join(src_dir, *SECRETSTORE_PARTS)
    vendor_dir = os.path.join(src_dir, *SECRETSTORE_VENDOR_PARTS)
    if os.path.isdir(vendor_dir):
        shutil.rmtree(vendor_dir)
    os.makedirs(vendor_dir)
    for name in SECRETSTORE_SOURCES:
        shutil.copy2(os.path.join(source_dir, name), os.path.join(vendor_dir, name))
    print(f"Vendored secretstore into {vendor_dir}")
    return vendor_dir


def load_manifest_module(src_dir):
    """Load the shared manifest producer/verifier by path."""
    path = _development_relative_path(src_dir, *MANIFEST_MODULE_PARTS)
    if not os.path.isfile(path):
        raise FileNotFoundError('Missing distribution manifest module: ' + path)
    spec = importlib.util.spec_from_file_location('distributionManifest', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def required_dist_members(deliver_raw):
    suffix = '.py' if deliver_raw else '.pyc'
    return sorted([m + suffix for m in REQUIRED_DIST_MODULES] +
                  list(REQUIRED_DIST_FILES))


def validate_dist_contents(dist_dir, deliver_raw=False):
    """Fail the build, loudly, if a required member is not in the staged tree."""
    missing = [m for m in required_dist_members(deliver_raw)
               if not os.path.isfile(os.path.join(dist_dir, *m.split('/')))]
    if missing:
        raise FileNotFoundError(
            'Distribution is missing required member(s): ' + ', '.join(missing))
    print('Validated %d required distribution members.'
          % len(required_dist_members(deliver_raw)))


def write_dist_manifest(src_dir, dist_dir, deliver_raw=False, compiled_sources=None):
    """Write dist_manifest.json into the staged tree, before it is archived."""
    manifest_module = load_manifest_module(src_dir)
    version = None
    try:
        with open(stream_data_json_path(src_dir), 'r', encoding='utf-8') as f:
            version = str(json.load(f).get('Version', '')).strip() or None
    except FileNotFoundError:
        pass
    files = manifest_module.describe_tree(dist_dir, compiled_sources)
    manifest = manifest_module.build_manifest(
        files, compiled=not deliver_raw,
        required=required_dist_members(deliver_raw), version=version,
        git=manifest_module.git_identity(_development_relative_path(src_dir)))
    manifest_module.write_manifest(dist_dir, manifest)
    print('Wrote %s: %s' % (manifest_module.MANIFEST_NAME,
                            manifest_module.summarize(manifest)))
    return manifest


def verify_built_archive(src_dir, archive_path):
    """Re-open the finished archive with the deploy-side verifier."""
    manifest_module = load_manifest_module(src_dir)
    manifest = manifest_module.verify_zip(archive_path)
    print('Verified %s: %s' % (archive_path, manifest_module.summarize(manifest)))
    return manifest


def copy_source_trees(src_dir, dist_dir, trees):
    """Copy listed source trees verbatim from src_dir into dist_dir.

    Skips dependency installs and build artifacts (see TREE_COPY_IGNORE)
    so the resulting zip stays small. All other files in the tree --
    including non-Python ones like package.json, tsconfig.json,
    vite.config.*, .env.example -- are preserved.
    """
    for rel_tree in trees:
        src_tree = os.path.join(src_dir, rel_tree)
        # The builder is supported from either the repository root
        # (Development/) or its parent workspace. In the latter layout the
        # operational Scripts source is Development/Scripts, but it must
        # always be emitted as Development/Scripts because the deployed
        # workflow and the script's ../.. root discovery require that depth.
        if os.path.normpath(rel_tree) == 'Scripts':
            parent_layout = os.path.join(src_dir, 'Development', 'Scripts')
            if os.path.isdir(parent_layout):
                src_tree = parent_layout
        if not os.path.isdir(src_tree):
            print(f"Source tree [{rel_tree}] not found (skipping).")
            continue
        target_tree = COPY_TREE_DESTINATIONS.get(
            os.path.normpath(rel_tree), rel_tree)
        dst_tree = os.path.join(dist_dir, target_tree)
        shutil.copytree(
            src_tree,
            dst_tree,
            ignore=_tree_copy_ignore_for(rel_tree, src_tree),
            dirs_exist_ok=True,
        )
        print(f"Copied source tree: {rel_tree} -> {target_tree}")


def validate_packaged_local_system_manager(dist_dir):
    """Fail before archiving if the deployed local-system entrypoint is absent."""
    manager = os.path.join(
        dist_dir, 'Development', 'Scripts', 'manage-local-system.sh')
    if not os.path.isfile(manager):
        raise FileNotFoundError(
            'Distribution is missing required local system manager: ' + manager)
    programmer = os.path.join(dist_dir, 'Development', 'Scripts', 'program-fpga-ram.py')
    if not os.path.isfile(programmer):
        raise FileNotFoundError('Distribution is missing FPGA RAM programmer: ' + programmer)
    print('Validated packaged local system manager: '
          'Development/Scripts/manage-local-system.sh')


def make_shell_scripts_executable(root):
    """Grant runtime execute permission to every packaged shell script."""
    updated = 0
    for dirpath, _, filenames in os.walk(root):
        for filename in filenames:
            if not filename.endswith('.sh'):
                continue
            path = os.path.join(dirpath, filename)
            if os.path.islink(path):
                continue
            mode = os.stat(path).st_mode
            os.chmod(path, mode | 0o111)
            updated += 1
    print(f'Granted executable permission to {updated} packaged shell script(s).')
    return updated


def _tree_copy_ignore_for(rel_tree, src_tree=None):
    """Return a per-tree ignore callback.

    The ionbeam-web tree should keep backend/deploy intact so the dist zip
    carries the full backend subtree, but still skip the top-level frontend
    deploy assets that are not needed in the packaged app.
    """
    base_ignore = set(TREE_COPY_IGNORE)
    if os.path.normpath(rel_tree) == os.path.join('Development', 'ionbeam-web'):
        def ignore(dirpath, names):
            ignored = set()
            rel_dir = os.path.normpath(os.path.relpath(dirpath, src_tree or rel_tree))
            for name in names:
                if any(fnmatch.fnmatch(name, pattern) for pattern in base_ignore):
                    ignored.add(name)
                    continue
                if name == 'deploy':
                    if rel_dir != 'backend':
                        ignored.add(name)
            return ignored

        return ignore

    return shutil.ignore_patterns(*base_ignore)


def copy_package_data(src_dir, dist_dir, trees):
    """Copy package data trees (no Python sources) into dist_dir."""
    for rel_tree in trees:
        src_tree = os.path.join(src_dir, rel_tree)
        if not os.path.isdir(src_tree):
            print(f"Package data tree [{rel_tree}] not found (skipping).")
            continue
        shutil.copytree(src_tree, os.path.join(dist_dir, rel_tree),
                        ignore=shutil.ignore_patterns(*PACKAGE_DATA_IGNORE),
                        dirs_exist_ok=True)
        print(f"Copied package data: {rel_tree}")


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


def _walk_roots(src_dir, package_roots):
    """os.walk over src_dir, or only over the named sub-roots of it.

    package_roots keeps a build launched from a parent workspace from
    packaging unrelated sibling directories.
    """
    roots = ([os.path.join(src_dir, r) for r in package_roots]
             if package_roots else [src_dir])
    for base in roots:
        if os.path.isdir(base):
            yield from os.walk(base)


def copy_matching_assets(src_dir, dist_dir, patterns, package_roots=None):
    """Walk src_dir (or only package_roots under it) and copy files matching patterns."""
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in _walk_roots(src_dir, package_roots):
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

def _file_sha256(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def compile_distribution_file(source, destination):
    """Compile the selected source, never an arbitrary cached interpreter copy.

    A sourceless deployment imports these files directly. A stale cache from
    another Python version must not overwrite the new controller, and a
    syntax error must stop packaging instead of retaining old gateware.
    """
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    py_compile.compile(source, cfile=destination, doraise=True, optimize=0)


def build_compiled_dist(src_dir, dist_dir, deliver_raw=False, package_roots=None):
    validate_glasgow_runtime_dependencies(src_dir)
    validate_local_redis_distribution_workflow(src_dir)
    # Compile each included source directly to its destination below. Do not
    # sweep __pycache__: it can contain stale copies for several interpreters.
    if deliver_raw:
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

    # 3. Package source files: raw .py files OR freshly compiled .pyc files
    abs_dist = os.path.abspath(dist_dir)
    compiled_sources = {}  # packaged .pyc path -> sha256 of the source it came from
    for root, dirs, files in _walk_roots(src_dir, package_roots):
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
            py_files = [f for f in files if f.endswith('.py')]
            if py_files:
                target_folder = os.path.join(dist_dir, rel_path)
                os.makedirs(target_folder, exist_ok=True)
                for filename in py_files:
                    clean_name = filename + 'c'
                    compile_distribution_file(
                        os.path.join(root, filename),
                        os.path.join(target_folder, clean_name))
                    compiled_sources[os.path.normpath(os.path.join(
                        rel_path, clean_name)).replace(os.sep, '/')] = \
                        _file_sha256(os.path.join(root, filename))
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

    # 5. Copy assets (includes README.md) and package data
    copy_matching_assets(src_dir, dist_dir, ASSET_PATTERNS, package_roots)
    copy_package_data(src_dir, dist_dir, PACKAGE_DATA_TREES)

    # The script must retain Development/Scripts depth so its ../.. root
    # discovery resolves to DeployRoot.
    make_shell_scripts_executable(dist_dir)
    validate_packaged_local_system_manager(dist_dir)
    validate_dist_contents(dist_dir, deliver_raw)
    assert_no_literal_credentials(src_dir, dist_dir, 'dist_app')
    write_dist_manifest(src_dir, dist_dir, deliver_raw, compiled_sources)

    # 6. Zip the output content (distinct names so raw/compiled don't overwrite)
    zip_name = "dist_app_raw" if deliver_raw else "dist_app"
    print(f"\nCreating archive {zip_name}.zip...")
    if os.path.exists(f"{zip_name}.zip"):
        os.remove(f"{zip_name}.zip")
    shutil.make_archive(zip_name, 'zip', dist_dir)
    try:
        verify_built_archive(src_dir, f"{zip_name}.zip")
    except Exception:
        # Never leave a zip that failed its own verification lying around.
        os.remove(f"{zip_name}.zip")
        raise
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
       5. remove the intermediate distribution zip from deploy_dir

    Step 4 picks up the freshly-placed dist zip from step 2 because
    deploy_dir lives inside workspace_dir.
    """
    archive_name = f"{zip_name}.zip"

    # Check first: never delete the last good archive when there is no new one.
    if not os.path.isfile(archive_name):
        raise FileNotFoundError(f"Build output not found: {archive_name}")

    # 1. Clear existing zips from the deploy slot
    print(f"\n--- Post-build: clearing zips in {deploy_dir} ---")
    clear_zips_in(deploy_dir)

    # 2. Move freshly built archive into the deploy slot
    moved_path = os.path.join(deploy_dir, archive_name)
    shutil.move(archive_name, moved_path)
    print(f"Moved {archive_name} -> {moved_path}")

    # 3. Strip bytecode droppings from the workspace before zipping it
    print(f"\n--- Post-build: cleaning bytecode under {workspace_dir} ---")
    clean_pycache_under(workspace_dir)

    # 4. Zip the entire workspace for handoff
    final_archive = zip_folder(workspace_dir, archive_base=workspace_archive_base)

    # Keep the intermediate archive on packaging failure so the build can
    # be recovered. The successful handoff already contains this archive.
    os.remove(moved_path)
    print(f"Removed intermediate archive: {moved_path}")
    return final_archive


def main(argv=None, script_path=None):
    parser = argparse.ArgumentParser(description='Build the deployable distribution.')
    parser.add_argument('-r', '--raw', action='store_true', dest='raw',
                        help="Deliver raw python code (skip byte-compilation)", default=False)
    parser.add_argument('--verify', metavar='ZIP', dest='verify',
                        help="Verify an existing distribution archive and exit")
    args = parser.parse_args(argv)
    script_path = script_path or __file__
    workspace = resolve_workspace(script_path)

    if args.verify:
        try:
            verify_built_archive(workspace, os.path.abspath(args.verify))
            return 0
        except Exception as e:
            print(f"Verification failed: {e}")
            return 1

    # Every relative path below (dist_app, the deploy slot, the handoff
    # archive) is relative to the workspace root, wherever we were launched.
    original_cwd = os.getcwd()
    os.chdir(workspace)
    exit_code = 0
    try:
        build_compiled_dist('.', './dist_app', deliver_raw=bool(args.raw),
                            package_roots=['Development'])
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
        vendor_dir = vendor_secretstore('.')
        try:
            assert_no_literal_credentials('.', workspace_dir, 'DeployWorkSpace handoff')
            final_archive = post_build_deploy(
                zip_name, deploy_dir, workspace_dir, workspace_archive_base)
        finally:
            # The vendored copy exists only inside the handoff archive.
            shutil.rmtree(os.path.dirname(vendor_dir), ignore_errors=True)
        print(f"Final handoff archive: {final_archive}")
        print("\nAll steps complete.")
    except Exception as e:
        print(f"\nBuild failed with error: {e}")
        exit_code = 1
    finally:
        os.chdir(original_cwd)

    # Flush so any final output reaches the terminal even if the runner is
    # buffering, then return an explicit code. Some launchers won't release
    # the terminal until the process delivers a definitive exit signal.
    sys.stdout.flush()
    sys.stderr.flush()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
