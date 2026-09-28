import re
TOK = re.compile(r'\s*(?:(\()|(\))|("(?:[^"\\]|\\.)*")|([^\s()"]+))')
class Sym(str): pass
def parse(text):
    pos=0; stack=[[]]
    while True:
        m=TOK.match(text,pos)
        if not m or m.end()==pos: break
        pos=m.end()
        if m.group(1): stack.append([])
        elif m.group(2):
            l=stack.pop(); stack[-1].append(l)
        elif m.group(3):
            stack[-1].append(m.group(3)[1:-1].replace('\\"','"').replace('\\\\','\\'))
        else: stack[-1].append(Sym(m.group(4)))
    return stack[0][0]
def q(s):
    return '"'+str(s).replace('\\','\\\\').replace('"','\\"').replace('\n','\\n')+'"'
def dump(x, ind=0):
    if isinstance(x,list):
        parts=[dump(e,ind+1) for e in x]
        simple=all(not isinstance(e,list) for e in x)
        if simple or len(' '.join(parts))<100 and '\n' not in ' '.join(parts):
            return '('+' '.join(parts)+')'
        out='('+parts[0]
        for p,e in zip(parts[1:],x[1:]):
            out+=('\n'+'  '*(ind+1)+p) if isinstance(e,list) else ' '+p
        return out+')'
    if isinstance(x,Sym): return str(x)
    if isinstance(x,(int,float)): return ('%g'%x) if isinstance(x,float) else str(x)
    return q(x)
def find(l,key): return [e for e in l if isinstance(e,list) and e and e[0]==key]
def find1(l,key):
    r=find(l,key); return r[0] if r else None
_libcache={}
def load_lib(name):
    if name not in _libcache:
        _libcache[name]=parse(open(f'/usr/share/kicad/symbols/{name}.kicad_sym').read())
    return _libcache[name]
def get_symbol(libid):
    lib,name=libid.split(':')
    L=load_lib(lib)
    for s in find(L,'symbol'):
        if s[1]==name: return s
    raise KeyError(libid)

def flat_symbol(libid):
    """Return a symbol with 'extends' resolved (KiCad schematics embed flattened symbols)."""
    s = get_symbol(libid)
    ext = find1(s, 'extends')
    if not ext:
        return s
    lib, name = libid.split(':')
    parent = flat_symbol(lib + ':' + ext[1])
    out = [parent[0], name]
    child_props = {p[1]: p for p in find(s, 'property')}
    for e in parent[2:]:
        if isinstance(e, list) and e and e[0] == 'property':
            out.append(child_props.pop(e[1], e))
        elif isinstance(e, list) and e and e[0] == 'symbol':
            sub = list(e); sub[1] = name + sub[1][len(ext[1]):]
            out.append(sub)
        else:
            out.append(e)
    for p in child_props.values():
        out.insert(2, p)
    return out
