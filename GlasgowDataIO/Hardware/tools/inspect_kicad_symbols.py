from pathlib import Path
import re
p = Path(r'C:/Project/IobeamTech/Development/GlasgowDataIO/Hardware/ScanSubtargetRevA/board/Open Beam Interface.kicad_sch')
s = p.read_text(encoding='utf-8')
for name in ('LT3045_MSE','LT3094_MSE'):
    i=s.find(f'(symbol "Scan Generator Symbols:{name}"')
    depth=0; j=i
    while j < len(s):
        if s[j]=='(': depth+=1
        elif s[j]==')':
            depth-=1
            if depth==0:
                j+=1; break
        j+=1
    print(f'---{name}---')
    print(s[i:j if j>0 else i+10000])
print('---hierarchical labels---')
for m in re.finditer(r'\(hierarchical_label [\s\S]*?\n\t\)',s): print(m.group(0))
