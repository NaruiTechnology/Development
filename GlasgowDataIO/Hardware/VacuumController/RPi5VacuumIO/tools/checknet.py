import sys
from sexp import parse, find, find1
import design
t = parse(open(sys.argv[1]).read())
nets = find1(t, "nets")
got = {}
for n in find(nets, "net"):
    name = find1(n, "name")[1].lstrip("/")
    for nd in find(n, "node"):
        got[(find1(nd, "ref")[1], find1(nd, "pin")[1])] = name
bad = 0
for c in design.C:
    if c["ref"].startswith("#"): continue
    for p, net in c["pins"].items():
        g = got.get((c["ref"], p))
        if net == "NC":
            if g and not g.startswith("unconnected-"): print("NC pin on net", c["ref"], p, g); bad += 1
        elif g != net:
            print("MISMATCH", c["ref"], p, "want", net, "got", g); bad += 1
# single-node nets
for n in find(nets, "net"):
    nodes = find(n, "node"); name = find1(n, "name")[1]
    if len(nodes) < 2 and not name.startswith("unconnected-"):
        print("single-node net", name); bad += 1
print("netlist check:", "PASS" if not bad else f"{bad} problems", "|", len(got), "pins")
