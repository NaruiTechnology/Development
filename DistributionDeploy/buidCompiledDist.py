import os
import shutil
import compileall
import re
import fnmatch

# Files (by name or glob) to copy verbatim into dist
ASSET_PATTERNS = ['*.ihex', 'requirements.txt', 'README.md']

# Updated: Added ".pytest_cache" to skip list. Removed ".venv" from output goals.
SKIP_DIRS = {
    '__pycache__', '.venv', '.git', '.pytest_cache', 'dist_app',
    'EsmBeamController', 'Open-Beam-Interface',
}

def copy_matching_assets(src_dir, dist_dir, patterns):
    """Walk src_dir and copy any files matching patterns into dist_dir."""
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        # Prune skipped dirs
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        
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
                print(f"Copied asset: {os.path.normpath(os.path.join(rel_path, filename))}")

def build_compiled_dist(src_dir, dist_dir):
    # 1. Byte-compile all .py files to __pycache__
    print(f"Compiling source in {src_dir} to .pyc...")
    compileall.compile_dir(src_dir, force=True, quiet=True, legacy=False)

    # 2. Refresh the dist folder
    if os.path.exists(dist_dir):
        shutil.rmtree(dist_dir, ignore_errors=True) 
    os.makedirs(dist_dir, exist_ok=True)

    # 3. Extract .pyc files and flatten names (removing cpython tags)
    abs_dist = os.path.abspath(dist_dir)
    for root, dirs, files in os.walk(src_dir):
        if os.path.abspath(root).startswith(abs_dist):
            continue
            
        if '__pycache__' in dirs:
            cache_path = os.path.join(root, '__pycache__')
            rel_path = os.path.relpath(root, src_dir)
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

    # 4. Copy specific JSON configuration folders
    json_sources = [r'Development/GlasgowDataIO/Json', r'Development/LoadFPGAImage/Json']
    for jx in json_sources:
        json_src = os.path.join(src_dir, jx)
        if os.path.exists(json_src):
            json_dist = os.path.join(dist_dir, jx)
            shutil.copytree(json_src, json_dist, dirs_exist_ok=True)
            print(f"Copied JSON folder: {jx}")

    # 5. Copy assets (includes README.md)
    copy_matching_assets(src_dir, dist_dir, ASSET_PATTERNS)

    # 6. Zip the output content
    zip_name = "disp_app"
    print(f"\nCreating archive {zip_name}.zip...")
    if os.path.exists(f"{zip_name}.zip"):
        os.remove(f"{zip_name}.zip")
    shutil.make_archive(zip_name, 'zip', dist_dir)
    print(f"Archive created successfully.")

if __name__ == "__main__":
    try:
        # Focusing exclusively on .pyc distribution
        build_compiled_dist('.', './dist_app')
        print("\nBuild complete! Output materials are in 'disp_app.zip'.")
    except Exception as e:
        print(f"\nBuild failed with error: {e}")