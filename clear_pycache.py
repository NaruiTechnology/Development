import os
import shutil

path = os.getcwd()
for directory, subfolders, files in os.walk(path):
    if os.path.basename(directory) == '__pycache__':
        shutil.rmtree(directory, ignore_errors=True)
        subfolders[:] = []
