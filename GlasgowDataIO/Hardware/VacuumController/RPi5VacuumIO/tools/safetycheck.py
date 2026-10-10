"""Static fail-safe checks on design.py (run after every change)."""
import design
from collections import defaultdict
C = {c["ref"]: c for c in design.C}
net_pins = defaultdict(list)
for c in design.C:
    for p, n in c["pins"].items():
        net_pins[n].append((c["ref"], p))
def on(net, ref_prefix=None, value=None):
    return [(r, p) for r, p in net_pins[net] if (ref_prefix is None or r.startswith(ref_prefix))
            and (value is None or C[r]["value"] == value)]
def resistor_to(net, other, value=None):
    for r, p in on(net, "R"):
        pins = C[r]["pins"]
        if other in pins.values() and (value is None or C[r]["value"] == value):
            return r
    return None
errors = []
def check(cond, msg):
    if not cond: errors.append(msg)

# 1. Expander reset: both MCP23017 RESET on IO_RESET_N, which is pulled down (reset while Pi absent).
for u in ("U1", "U3"):
    check(C[u]["pins"]["18"] == "IO_RESET_N", f"{u} RESET not on IO_RESET_N")
check(resistor_to("IO_RESET_N", "GND"), "IO_RESET_N has no pull-down")
# 2. Every relay driver input and every MOSFET gate is pulled down.
for n in range(1, 9):
    check(resistor_to(f"RLY_IN{n}", "GND"), f"RLY_IN{n} lacks pull-down")
    check(resistor_to(f"SOL_G{n}", "GND"), f"SOL_G{n} lacks pull-down")
# 3. Relay coils only on the switched rails; solenoids only on +24V_SAFE with flyback.
for n in range(1, 9):
    jp = C[f"JP{n}"]["pins"]
    check({jp["1"], jp["3"]} == {"+24V_ESTOP", "+24V_SAFE"}, f"JP{n} rails wrong")
    check(C[f"K{n}"]["pins"]["5"] == f"RLY_V{n}", f"K{n} coil not on its selected rail")
    default = jp["1"]
    check(default == ("+24V_ESTOP" if n == 1 else "+24V_SAFE"), f"K{n} default rail unexpected: {default}")
    flyback = [r for r, p in on(f"SOL_D{n}", "D") if C[r]["pins"].get("1") == "+24V_SAFE"]
    check(flyback, f"SOL_D{n} has no flyback diode to +24V_SAFE")
    pins = [c for c in design.C if c["ref"].startswith("J2") and f"SOL_D{n}" in c["pins"].values()][0]["pins"]
    check("+24V_SAFE" in pins.values(), f"solenoid {n} terminal not paired with +24V_SAFE")
check(C["U2"]["pins"]["10"] == "+24V_ESTOP", "ULN2803 COM (coil clamp) not on +24V_ESTOP")
# 4. Rail chain: +24V -> K9 (coil via E-stop loop) -> +24V_ESTOP -> K10 (watchdog) -> +24V_SAFE
k9, k10 = C["K9"]["pins"], C["K10"]["pins"]
check(k9["1"] == "+24V" and k9["4"] == "+24V_ESTOP" and k9["5"] == "ESTOP_RET", "K9 wiring")
check(C["J2"]["pins"]["2"] == "ESTOP_RET", "E-stop loop does not feed K9 coil")
check(k10["1"] == "+24V_ESTOP" and k10["4"] == "+24V_SAFE" and k10["5"] == "+24V_ESTOP", "K10 wiring")
check(C["Q9"]["pins"]["3"] == "WDT_DRAIN" and k10["2"] == "WDT_DRAIN", "K10 not driven by watchdog FET")
# 5. Watchdog is AC-coupled: heartbeat reaches the gate only through a capacitor.
check(any(C[r]["lib"] == "Device:C" for r, _ in on("WDT_HB_R")), "heartbeat not AC coupled")
check(resistor_to("WDT_GATE", "GND"), "watchdog gate has no bleed resistor")
# 6. Pi 5 V pins not used; 3V3 only.
pi = C["J3"]["pins"]
check(pi["2"] == "NC" and pi["4"] == "NC", "Pi 5V pins connected")
# 7. Every coil has a flyback path.
check(C["D4"]["pins"] == {"1": "ESTOP_RET", "2": "GND"}, "K9 flyback")
check(C["D5"]["pins"] == {"1": "+24V_ESTOP", "2": "WDT_DRAIN"}, "K10 flyback")
# 8. Analog inputs clamped.
for n in range(1, 9):
    check(any(C[r]["lib"] == "Diode:BAT54S" for r, _ in on(f"AI_S{n}")), f"AI{n} not clamped")
print("safety check:", "PASS" if not errors else "FAIL")
for e in errors: print("  -", e)
raise SystemExit(1 if errors else 0)
