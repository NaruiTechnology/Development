import os
import shutil
import compileall
import re
import fnmatch

# Files (by name or glob) to copy verbatim into dist, preserving directory structure
ASSET_PATTERNS = ['*.ihex', 'requirements.txt']

# Directories to skip when walking the source tree (for both .pyc and asset copy)
SKIP_DIRS = {
    '__pycache__', '.venv', '.git', 'dist_app',
    'EsmBeamController', 'Open-Beam-Interface',
}


def copy_matching_assets(src_dir, dist_dir, patterns):
    """Walk src_dir and copy any files matching the given glob patterns
    into dist_dir, preserving relative directory structure."""
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        # Prune skipped dirs in-place so os.walk does not descend into them
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
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


def build_compiled_dist(src_dir, dist_dir):
    # 1. Compile all .py files to __pycache__
    print(f"Compiling source in {src_dir}...")
    compileall.compile_dir(src_dir, force=True, quiet=True)

    if os.path.exists(dist_dir):
        shutil.rmtree(dist_dir)
    os.makedirs(dist_dir)

    # 2. Walk through the source to find compiled files
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        # Don't recurse into the output folder
        if os.path.abspath(root).startswith(abs_dist):
            continue
        # Prune skipped dirs in-place (excluded projects, .venv, .git, etc.).
        # We keep '__pycache__' available for the check below, then prune it
        # so we don't descend into it on the next iteration.
        dirs[:] = [d for d in dirs if d == '__pycache__' or d not in SKIP_DIRS]
        if '__pycache__' in dirs:
            cache_path = os.path.join(root, '__pycache__')
            # Determine the destination relative to the dist folder
            rel_path = os.path.relpath(root, src_dir)
            target_folder = os.path.join(dist_dir, rel_path)

            if not os.path.exists(target_folder):
                os.makedirs(target_folder)

            for filename in os.listdir(cache_path):
                # Match the pattern: name.cpython-XY.pyc
                match = re.match(r"(.+)\.cpython-\d+\.pyc", filename)
                if match:
                    clean_name = f"{match.group(1)}.pyc"
                    src_file = os.path.join(cache_path, filename)
                    dest_file = os.path.join(target_folder, clean_name)

                    shutil.copy2(src_file, dest_file)
                    print(f"Packaged: {clean_name}")

    # 3. Copy non-python assets (JSON config folders)
    json_sources = [r'Development/GlasgowDataIO/Json', r'Development/LoadFPGAImage/Json']
    for jx in json_sources:
        json_src = os.path.join(src_dir, jx)
        if os.path.exists(json_src):
            json_dist = os.path.join(dist_dir, jx)
            shutil.copytree(json_src, json_dist)
            print(f"Copied JSON configuration files [{jx}].")

    # 4. Copy other assets matching patterns (e.g. *.ihex firmware, requirements.txt)
    copy_matching_assets(src_dir, dist_dir, ASSET_PATTERNS)

    # 5. Copy .venv tree
    venv_src = os.path.join(r'./', r'.venv')
    if os.path.exists(venv_src):
        venv_dist = os.path.join(dist_dir, r'.venv')
        if os.path.exists(venv_dist):
            shutil.rmtree(venv_dist)

        shutil.copytree(venv_src, venv_dist)
        print("Copied virtual environment.")


if __name__ == "__main__":
    build_compiled_dist('.', './dist_app')
    print("\nBuild complete! Your compiled app is in the './dist_app' folder.")
