from pathlib import Path
import re
s=Path(r'C:/Project/IobeamTech/Development/GlasgowDataIO/Hardware/ScanSubtargetRevA/evidence/kicad10/after4.net').read_text()
for m in re.finditer(r'\n\t\t\(net\n([\s\S]*?)\n\t\t\)', s):
    b=m.group(1)
    if any(x in b for x in ['U1")','U19")']): print(b+'\n---')
