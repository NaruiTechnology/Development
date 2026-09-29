"""Build a relocatable Linux x64 folder from installed Electron and built assets."""
from pathlib import Path
import shutil
import json
import argparse

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, help='write the unpacked app under this directory')
args = parser.parse_args()
target = (args.output_dir.expanduser().resolve() if args.output_dir else root / 'release') / 'IonbeamDesktop-linux-x64'
if target.exists():
    raise SystemExit(f'{target} already exists; move it aside before rebuilding')
electron = root / 'node_modules' / 'electron' / 'dist'
if not electron.is_dir():
    raise SystemExit('Run npm ci first')
shutil.copytree(electron, target)
app = target / 'resources' / 'app'
app.mkdir()
for name in ('desktop', 'docs'):
    shutil.copytree(root / name, app / name)
shutil.copy2(root / 'package.json', app / 'package.json')
for name in ('backend', 'frontend'):
    base = Path('runtime/ionbeam-web') / name
    shutil.copytree(root / base / 'dist', app / base / 'dist')
    if name == 'backend':
        shutil.copytree(root / base / 'node_modules', app / base / 'node_modules',
                        ignore=shutil.ignore_patterns('.cache', '*.map'))
launcher = target / 'ionbeam-desktop'
launcher.write_text('#!/bin/sh\nset -eu\nAPP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$APP_DIR/electron" "$APP_DIR/resources/app" "$@"\n')
launcher.chmod(0o755)
print(target)
