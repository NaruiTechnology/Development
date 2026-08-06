import os
import shutil
from pathlib import Path


root_path = Path(__file__).resolve().parent

for directory, subfolders, _files in os.walk(root_path):
    if Path(directory).name == "__pycache__":
        shutil.rmtree(directory, ignore_errors=True)
        subfolders.clear()
