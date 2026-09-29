"""Register an installed desktop scanner for ionbeam:// links, for this user."""
import argparse
from pathlib import Path
import os
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('application', type=Path, help='Path to release/IonbeamDesktop-linux-x64/ionbeam-desktop')
args = parser.parse_args()
launcher = args.application.expanduser().resolve(strict=True)
if not launcher.is_file() or not os.access(launcher, os.X_OK):
    raise SystemExit('Application launcher must be an executable file')
# Desktop Entry Exec quoting, not shell quoting. % is a desktop field code.
escaped = str(launcher).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%')
home = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share'))
applications = home / 'applications'
applications.mkdir(parents=True, exist_ok=True)
entry = applications / 'ionbeam-desktop.desktop'
entry.write_text(f'''[Desktop Entry]
Type=Application
Name=Ion Beam Desktop Scanner
Comment=Raster, vector and ROI acquisition
Exec="{escaped}" %u
Terminal=false
Categories=Science;Engineering;
MimeType=x-scheme-handler/ionbeam;
''')
subprocess.run(['xdg-mime', 'default', entry.name, 'x-scheme-handler/ionbeam'], check=True)
print(f'Registered {entry}; browser links will open {launcher}')
