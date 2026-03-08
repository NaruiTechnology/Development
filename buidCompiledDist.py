import os
import shutil
import compileall
import re

def build_compiled_dist(src_dir, dist_dir):
    # 1. Compile all .py files to __pycache__
    print(f"Compiling source in {src_dir}...")
    compileall.compile_dir(src_dir, force=True, quiet=True)

    if os.path.exists(dist_dir):
        shutil.rmtree(dist_dir)
    os.makedirs(dist_dir)

    # 2. Walk through the source to find compiled files
    for root, dirs, files in os.walk(src_dir):
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

    # 3. Copy non-python assets (like your JSON config)
    json_sources =  [r'Development/GlasgowDataIO/Json', r'Development/LoadFPGAImage/Json']
    for jx in json_sources:
        json_src = os.path.join(src_dir, jx)
        if os.path.exists(json_src):
            json_dist = os.path.join(dist_dir, jx)
            shutil.copytree(json_src, json_dist)
            print(f"Copied JSON configuration files [{jx}].")

    # 4. Copy .venv tree 
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