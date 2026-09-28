"""RPi5 Vacuum Controller I/O board, rev A - single source of truth.

Raspberry Pi 5 (via 40-pin ribbon) controls the FEI DB235 vacuum system:
  8 x SPDT relay outputs      MechanicalVacuumPump, TurboVacuumPump, UHVacuumPump_1/_2, HighVoltageTransformer, 3 spares
  8 x 24 V solenoid drivers   valves and pneumatic cylinders
 16 x isolated 24 V inputs    pump status, valve/cylinder position, door, air, N2, water
  8 x 0-10 V analog inputs    vacuum gauges, pump analog outputs
  RS-485 + RS-232             turbo / gauge controllers
  E-stop loop + Pi watchdog   hardware removal of output power
"""
C = []
def comp(ref, lib, value, fp, pins, units=None, mpn="", desc=""):
    C.append(dict(ref=ref, lib=lib, value=value, fp=fp, pins=pins, units=units or [1], mpn=mpn, desc=desc))

R0805 = "Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder"
R1206 = "Resistor_SMD:R_1206_3216Metric_Pad1.30x1.75mm_HandSolder"
C0805 = "Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder"
C1210 = "Capacitor_SMD:C_1210_3225Metric_Pad1.33x2.70mm_HandSolder"
LED = "LED_SMD:LED_0805_2012Metric_Pad1.15x1.40mm_HandSolder"
SOD123 = "Diode_SMD:D_SOD-123"
SMA = "Diode_SMD:D_SMA"
SOT23 = "Package_TO_SOT_SMD:SOT-23"
RELAY = "Relay_THT:Relay_SPDT_Omron-G5LE-1"
MSTB2 = "Connector_Phoenix_MSTB:PhoenixContact_MSTBA_2,5_2-G-5,08_1x02_P5.08mm_Horizontal"
MSTB3 = "Connector_Phoenix_MSTB:PhoenixContact_MSTBA_2,5_3-G-5,08_1x03_P5.08mm_Horizontal"
MC = "Connector_Phoenix_MC:PhoenixContact_MC_1,5_%d-G-3.5_1x%02d_P3.50mm_Horizontal"
JP3 = "Jumper:SolderJumper-3_P1.3mm_Bridged12_RoundedPad1.0x1.5mm"
JP2O = "Jumper:SolderJumper-2_P1.3mm_Open_RoundedPad1.0x1.5mm"

def R(ref, v, a, b, fp=R0805, desc=""):
    comp(ref, "Device:R", v, fp, {"1": a, "2": b}, mpn=f"{fp.split('_')[1]} {v} 1%", desc=desc)
def Cap(ref, v, a, b, fp=C0805, mpn=None, desc=""):
    comp(ref, "Device:C", v, fp, {"1": a, "2": b}, mpn=mpn or f"0805 {v} 50V X7R", desc=desc)
def Led(ref, color, a, k, desc=""):
    comp(ref, "Device:LED", color, LED, {"2": a, "1": k}, mpn=f"0805 {color} LED", desc=desc)
def Dio(ref, v, k, a, fp=SOD123, mpn=None, desc=""):
    comp(ref, "Device:D", v, fp, {"1": k, "2": a}, mpn=mpn or v, desc=desc)

# ================================================================ power
comp("J1", "Connector_Generic:Conn_01x02", "24VDC_IN", MSTB2, {"1": "+24V_RAW", "2": "GND"},
     mpn="Phoenix 1757242 (MSTBA 2,5/2-G-5,08); plug 1757019", desc="24 V DC field supply input")
comp("F1", "Device:Fuse", "4A T", "Fuse:Fuse_Littelfuse_395Series", {"1": "+24V_RAW", "2": "+24V_F"},
     mpn="Littelfuse 39214000000 (TR5 4 A slow)", desc="Main fuse")
Dio("D1", "SS54", "+24V", "+24V_F", fp="Diode_SMD:D_SMC", mpn="SS54 (5 A 40 V Schottky, SMC)", desc="Reverse-polarity protection")
comp("D2", "Device:D_TVS", "SMAJ33CA", SMA, {"1": "+24V", "2": "GND"}, mpn="Littelfuse SMAJ33CA", desc="24 V rail surge clamp")
comp("C1", "Device:C_Polarized", "47uF 50V", "Capacitor_SMD:CP_Elec_8x10", {"1": "+24V", "2": "GND"},
     mpn="Panasonic EEE-FK1H470P", desc="24 V bulk")
Cap("C2", "100nF", "+24V", "GND")
comp("F2", "Device:Polyfuse", "0.5A 30V", "Fuse:Fuse_1812_4532Metric", {"1": "+24V", "2": "+24V_AUX"},
     mpn="Littelfuse 1812L050/30DR", desc="Sensor / E-stop loop supply")
R("R1", "4.7k", "+24V", "LED_24V", fp=R1206); Led("D3", "GRN", "LED_24V", "GND", desc="24 V present")
Cap("C3", "10uF", "+3V3", "GND", mpn="0805 10uF 16V X5R", desc="3V3 bulk (3V3 comes from the Pi)")

# ================================================================ E-stop and watchdog rails
comp("J2", "Connector_Generic:Conn_01x02", "ESTOP", MC % (2, 2) if False else "Connector_Phoenix_MC:PhoenixContact_MC_1,5_2-G-3.5_1x02_P3.50mm_Horizontal",
     {"1": "+24V_AUX", "2": "ESTOP_RET"}, mpn="Phoenix 1844210; plug 1840366", desc="E-stop NC loop (or safety-relay output)")
comp("K9", "Relay:G5LE-1", "G5LE-1 24VDC", RELAY,
     {"5": "ESTOP_RET", "2": "GND", "1": "+24V", "4": "+24V_ESTOP", "3": "NC"},
     mpn="Omron G5LE-1 DC24", desc="E-stop rail relay")
Dio("D4", "1N4148W", "ESTOP_RET", "GND", desc="K9 coil flyback")
comp("K10", "Relay:G5LE-1", "G5LE-1 24VDC", RELAY,
     {"5": "+24V_ESTOP", "2": "WDT_DRAIN", "1": "+24V_ESTOP", "4": "+24V_SAFE", "3": "NC"},
     mpn="Omron G5LE-1 DC24", desc="Watchdog rail relay")
Dio("D5", "1N4148W", "+24V_ESTOP", "WDT_DRAIN", desc="K10 coil flyback")
comp("Q9", "Transistor_FET:AO3400A", "AO3400A", SOT23, {"1": "WDT_GATE", "2": "GND", "3": "WDT_DRAIN"},
     mpn="AOS AO3400A", desc="K10 coil driver")
R("R2", "100R", "WDT_HB", "WDT_HB_R", desc="Heartbeat series")
Cap("C4", "1uF", "WDT_HB_R", "WDT_AC", mpn="0805 1uF 25V X7R", desc="Charge pump coupling (blocks DC: stuck pin = trip)")
comp("D6", "Diode:BAT54S", "BAT54S", SOT23, {"1": "GND", "3": "WDT_AC", "2": "WDT_GATE"},
     mpn="BAT54S", desc="Charge pump diodes")
Cap("C5", "1uF", "WDT_GATE", "GND", mpn="0805 1uF 25V X7R", desc="Charge pump hold")
R("R3", "100k", "WDT_GATE", "GND", desc="Watchdog bleed, ~100 ms drop-out")
Dio("D7", "SS34", "+24V_ESTOP", "GND", fp=SMA, mpn="SS34 (3 A 40 V Schottky)", desc="ESTOP rail freewheel")
Dio("D8", "SS34", "+24V_SAFE", "GND", fp=SMA, mpn="SS34 (3 A 40 V Schottky)", desc="SAFE rail freewheel")
Cap("C6", "10uF", "+24V_ESTOP", "GND", fp=C1210, mpn="1210 10uF 50V X7R")
Cap("C7", "10uF", "+24V_SAFE", "GND", fp=C1210, mpn="1210 10uF 50V X7R")
R("R4", "4.7k", "+24V_ESTOP", "LED_EST", fp=R1206); Led("D9", "YEL", "LED_EST", "GND", desc="E-stop rail live")
R("R5", "4.7k", "+24V_SAFE", "LED_SAFE", fp=R1206); Led("D10", "GRN", "LED_SAFE", "GND", desc="Output rail live (E-stop + watchdog OK)")
# rail status back to the Pi (opto, active low)
comp("U13", "Isolator:TLP291-4", "TLP291-4", "Package_SO:SOIC-16_4.55x10.3mm_P1.27mm",
     {"1": "ST_A1", "2": "GND", "16": "ESTOP_OK_N", "15": "GND",
      "3": "ST_A2", "4": "GND", "14": "SAFE_OK_N", "13": "GND",
      "5": "GND", "6": "GND", "12": "NC", "11": "GND",
      "7": "GND", "8": "GND", "10": "NC", "9": "GND"},
     units=[1, 2, 3, 4], mpn="Toshiba TLP291-4(GB-TP,E)", desc="Rail status to Pi GPIO5/6")
R("R6", "10k", "+24V_ESTOP", "ST_A1", fp=R1206); R("R7", "10k", "+24V_SAFE", "ST_A2", fp=R1206)
R("R8", "10k", "+3V3", "ESTOP_OK_N"); R("R9", "10k", "+3V3", "SAFE_OK_N")

# ================================================================ Raspberry Pi header
PI = {1: "+3V3", 17: "+3V3", 3: "SDA", 5: "SCL", 8: "RS485_TX", 10: "RS485_RX", 12: "RS485_DE",
      13: "DI_INT", 15: "IO_RESET_N", 16: "ADC_ALRT", 29: "ESTOP_OK_N", 31: "SAFE_OK_N",
      32: "RS232_TX", 33: "RS232_RX", 35: "WDT_HB", 37: "RUN_LED"}
for g in (6, 9, 14, 20, 25, 30, 34, 39): PI[g] = "GND"
comp("J3", "Connector_Generic:Conn_02x20_Odd_Even", "RPI5_40PIN", "Connector_IDC:IDC-Header_2x20_P2.54mm_Vertical",
     {str(i): PI.get(i, "NC") for i in range(1, 41)}, mpn="2x20 2.54 mm shrouded box header + 40-way IDC ribbon",
     desc="To Raspberry Pi 5 GPIO header (5 V pins deliberately not connected)")
R("R10", "10k", "IO_RESET_N", "GND", desc="Holds MCP23017s in reset (all outputs off) until the Pi drives GPIO22 high")
R("R11", "1k", "RUN_LED", "LED_RUN"); Led("D11", "BLU", "LED_RUN", "GND", desc="Software RUN (GPIO26)")

# ================================================================ output expander + relay drivers
comp("U1", "Interface_Expansion:MCP23017_SO", "MCP23017", "Package_SO:SOIC-28W_7.5x17.9mm_P1.27mm",
     dict({"9": "+3V3", "10": "GND", "12": "SCL", "13": "SDA", "15": "GND", "16": "GND", "17": "GND",
           "18": "IO_RESET_N", "19": "NC", "20": "NC", "11": "NC", "14": "NC"},
          **{str(21 + i): f"RLY_IN{i+1}" for i in range(8)},
          **{str(1 + i): f"SOL_IN{i+1}" for i in range(8)}),
     mpn="Microchip MCP23017-E/SO", desc="Outputs, I2C 0x20")
Cap("C8", "100nF", "+3V3", "GND")
comp("U2", "Transistor_Array:ULN2803A", "ULN2803A", "Package_SO:SOIC-18W_7.5x11.6mm_P1.27mm",
     dict({"9": "GND", "10": "+24V_ESTOP"}, **{str(1 + i): f"RLY_IN{i+1}" for i in range(8)},
          **{str(18 - i): f"RLY_L{i+1}" for i in range(8)}),
     mpn="TI ULN2803ADWR", desc="Relay coil drivers")
# Matches glasgow_service vacuumSystem.json and the SBC Vacuum Controller dashboard (A0..A4).
RELAY_USE = ["A0 MechanicalVacuumPump", "A1 TurboVacuumPump", "A2 UHVacuumPump_1 (turbo)", "A3 UHVacuumPump_2 (turbo)",
             "A4 HighVoltageTransformer", "A5 gauge HV / spare", "A6 spare", "A7 spare"]
for i in range(8):
    n = i + 1
    R(f"R{20+n}", "100k", f"RLY_IN{n}", "GND", desc="Relay input pull-down (off while expander in reset)")
    comp(f"K{n}", "Relay:G5LE-1", "G5LE-1 24VDC", RELAY,
         {"5": f"RLY_V{n}", "2": f"RLY_L{n}", "1": f"K{n}_COM", "4": f"K{n}_NO", "3": f"K{n}_NC"},
         mpn="Omron G5LE-1 DC24", desc=f"Relay {n}: {RELAY_USE[i]}")
    a, b = ("+24V_ESTOP", "+24V_SAFE") if n == 1 else ("+24V_SAFE", "+24V_ESTOP")
    comp(f"JP{n}", "Jumper:SolderJumper_3_Bridged12", "RAIL_SEL", JP3,
         {"1": a, "2": f"RLY_V{n}", "3": b},
         desc="Coil rail: 1-2 default (K1 = E-stop rail only, K2-K8 = E-stop + watchdog rail)")
    R(f"R{30+n}", "4.7k", f"RLY_V{n}", f"RLY_LED{n}", fp=R1206)
    Led(f"D{20+n}", "RED", f"RLY_LED{n}", f"RLY_L{n}", desc=f"K{n} energised")
    comp(f"J{10+n}", "Connector_Generic:Conn_01x03", f"RELAY{n}", MSTB3,
         {"1": f"K{n}_COM", "2": f"K{n}_NO", "3": f"K{n}_NC"},
         mpn="Phoenix 1757255 (MSTBA 2,5/3-G-5,08); plug 1757022", desc=f"Relay {n} contacts COM/NO/NC")

# ================================================================ solenoid drivers
SOL_USE = ["V1 ROUGH", "V2 CHAMBER", "V3 VENT", "V4 COLUMN", "V5 GUN", "V6 BYPASS", "V7 CYL", "V8 SPARE"]
for i in range(8):
    n = i + 1
    R(f"R{40+n}", "100R", f"SOL_IN{n}", f"SOL_G{n}")
    R(f"R{50+n}", "100k", f"SOL_G{n}", "GND", desc="Gate pull-down: off while expander in reset")
    comp(f"Q{n}", "Transistor_FET:AO3400A", "AO3400A", SOT23, {"1": f"SOL_G{n}", "2": "GND", "3": f"SOL_D{n}"},
         mpn="AOS AO3400A", desc=f"Solenoid {n} low-side switch")
    Dio(f"D{30+n}", "SS14", "+24V_SAFE", f"SOL_D{n}", fp=SMA, mpn="SS14 (1 A 40 V Schottky)", desc="Solenoid flyback")
    R(f"R{60+n}", "4.7k", "+24V_SAFE", f"SOL_LED{n}", fp=R1206)
    Led(f"D{40+n}", "YEL", f"SOL_LED{n}", f"SOL_D{n}", desc=f"Solenoid {n} on")
for g in range(4):
    a, b = 2 * g + 1, 2 * g + 2
    comp(f"J{20+g+1}", "Connector_Generic:Conn_01x04", f"SOL{a}-{b}", MC % (4, 4),
         {"1": "+24V_SAFE", "2": f"SOL_D{a}", "3": "+24V_SAFE", "4": f"SOL_D{b}"},
         mpn="Phoenix 1844236; plug 1840382", desc=f"Solenoid outputs {a},{b} (+24V, OUT-)")

# ================================================================ isolated digital inputs
comp("U3", "Interface_Expansion:MCP23017_SO", "MCP23017", "Package_SO:SOIC-28W_7.5x17.9mm_P1.27mm",
     dict({"9": "+3V3", "10": "GND", "12": "SCL", "13": "SDA", "15": "+3V3", "16": "GND", "17": "GND",
           "18": "IO_RESET_N", "19": "NC", "20": "DI_INT", "11": "NC", "14": "NC"},
          **{str(21 + i): f"DI_N{i+1}" for i in range(8)},
          **{str(1 + i): f"DI_N{i+9}" for i in range(8)}),
     mpn="Microchip MCP23017-E/SO", desc="Inputs, I2C 0x21")
Cap("C9", "100nF", "+3V3", "GND")
R("R12", "10k", "+3V3", "DI_INT", desc="INTA open-drain pull-up")
OPTO_UNITS = [("1", "2", "16", "15"), ("3", "4", "14", "13"), ("5", "6", "12", "11"), ("7", "8", "10", "9")]
for q in range(4):
    pins = {}
    for u, (a, k, c, e) in enumerate(OPTO_UNITS):
        n = 4 * q + u + 1
        pins.update({a: f"DI_A{n}", k: f"DI_COM{q+1}", c: f"DI_N{n}", e: "GND"})
    comp(f"U{5+q}", "Isolator:TLP291-4", "TLP291-4", "Package_SO:SOIC-16_4.55x10.3mm_P1.27mm", pins,
         units=[1, 2, 3, 4], mpn="Toshiba TLP291-4(GB-TP,E)", desc=f"Inputs {4*q+1}-{4*q+4}")
    comp(f"J{30+q+1}", "Connector_Generic:Conn_01x06", f"DI{4*q+1}-{4*q+4}", MC % (6, 6),
         {"1": f"DI{4*q+1}", "2": f"DI{4*q+2}", "3": f"DI{4*q+3}", "4": f"DI{4*q+4}",
          "5": f"DI_COM{q+1}", "6": "+24V_AUX"},
         mpn="Phoenix 1844252 (MC 1,5/6-G-3,5); plug 1840395", desc="4 inputs + common + 24 V sensor supply")
DI_USE = {1: "B0 MechanicalVacuumPump ready", 2: "B1 TurboVacuumPump at speed", 3: "B2 UHVacuumPump_1 at speed",
          4: "B3 UHVacuumPump_2 at speed", 5: "MechanicalVacuumPump fault", 6: "TurboVacuumPump fault",
          7: "UHVacuumPump_1 fault", 8: "UHVacuumPump_2 fault"}
for n in range(1, 17):
    q = (n - 1) // 4 + 1
    R(f"R{100+n}", "4.7k", f"DI{n}", f"DI_L{n}", fp=R1206, desc="Input current limit ~4.5 mA at 24 V")
    Led(f"D{100+n}", "GRN", f"DI_L{n}", f"DI_A{n}", desc=f"Input {n} active" + (f" - {DI_USE[n]}" if n in DI_USE else ""))
    Dio(f"D{120+n}", "1N4148W", f"DI_L{n}", f"DI_COM{q}", desc="Reverse-polarity bypass")
    R(f"R{120+n}", "10k", "+3V3", f"DI_N{n}", desc="Opto collector pull-up")

# ================================================================ analog gauge inputs
comp("U9", "Analog_ADC:ADS1115IDGS", "ADS1115", "Package_SO:TSSOP-10_3x3mm_P0.5mm",
     {"1": "GND", "2": "ADC_ALRT", "3": "GND", "4": "AI_S1", "5": "AI_S2", "6": "AI_S3", "7": "AI_S4",
      "8": "+3V3", "9": "SDA", "10": "SCL"}, mpn="TI ADS1115IDGSR", desc="Gauges 1-4, I2C 0x48")
comp("U10", "Analog_ADC:ADS1115IDGS", "ADS1115", "Package_SO:TSSOP-10_3x3mm_P0.5mm",
     {"1": "+3V3", "2": "ADC_ALRT", "3": "GND", "4": "AI_S5", "5": "AI_S6", "6": "AI_S7", "7": "AI_S8",
      "8": "+3V3", "9": "SDA", "10": "SCL"}, mpn="TI ADS1115IDGSR", desc="Gauges 5-8, I2C 0x49")
Cap("C10", "100nF", "+3V3", "GND"); Cap("C11", "100nF", "+3V3", "GND")
R("R13", "10k", "+3V3", "ADC_ALRT", desc="ALERT/RDY open-drain pull-up")
AI_USE = {1: "MechanicalVacuumPump gauge", 2: "TurboVacuumPump gauge", 3: "UHVacuumPump_1 gauge",
          4: "UHVacuumPump_2 gauge", 5: "TurboVacuumPump speed", 6: "UHVacuumPump_1 speed", 7: "UHVacuumPump_2 speed"}
for n in range(1, 9):
    R(f"R{140+n}", "68k", f"AI{n}", f"AI_S{n}", desc="0-10.5 V -> 0-2.57 V divider (top)" + (f"; AI{n} = {AI_USE[n]}" if n in AI_USE else ""))
    R(f"R{150+n}", "22k", f"AI_S{n}", "GND", desc="Divider bottom")
    Cap(f"C{20+n}", "100nF", f"AI_S{n}", "GND", desc="Anti-alias, fc ~90 Hz")
    comp(f"D{60+n}", "Diode:BAT54S", "BAT54S", SOT23, {"1": "GND", "2": "+3V3", "3": f"AI_S{n}"},
         mpn="BAT54S", desc="ADC input clamp")
for g in range(2):
    comp(f"J{40+g+1}", "Connector_Generic:Conn_01x08", f"AI{4*g+1}-{4*g+4}", MC % (8, 8),
         {str(2 * k + 1): f"AI{4*g+k+1}" for k in range(4)} | {str(2 * k + 2): "GND" for k in range(4)},
         mpn="Phoenix 1844265 (MC 1,5/8-G-3,5); plug 1840411", desc="Analog in / AGND pairs")

# ================================================================ RS-485
comp("U11", "Interface_UART:MAX3485", "MAX3485", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
     {"1": "RS485_RX", "2": "RS485_DE", "3": "RS485_DE", "4": "RS485_TX", "5": "GND",
      "6": "RS485_A", "7": "RS485_B", "8": "+3V3"}, mpn="MAX3485ESA+ (or SP3485EN)", desc="RS-485 half duplex, UART0 - multi-drop bus to the three turbo pump controllers")
Cap("C12", "100nF", "+3V3", "GND")
R("R14", "10k", "RS485_DE", "GND", desc="Receive by default")
R("R15", "680R", "+3V3", "RS485_A", desc="Fail-safe bias"); R("R16", "680R", "RS485_B", "GND", desc="Fail-safe bias")
R("R17", "120R", "RS485_A", "RS485_T"); comp("JP9", "Jumper:SolderJumper_2_Open", "TERM", JP2O,
     {"1": "RS485_T", "2": "RS485_B"}, desc="Bridge for 120R termination")
comp("D12", "Device:D_TVS", "SMAJ12CA", SMA, {"1": "RS485_A", "2": "GND"}, mpn="SMAJ12CA")
comp("D13", "Device:D_TVS", "SMAJ12CA", SMA, {"1": "RS485_B", "2": "GND"}, mpn="SMAJ12CA")
comp("J4", "Connector_Generic:Conn_01x03", "RS485", MC % (3, 3), {"1": "RS485_A", "2": "RS485_B", "3": "GND"},
     mpn="Phoenix 1844223; plug 1840379", desc="RS-485 A/B/GND")

# ================================================================ RS-232
comp("U12", "Interface_UART:MAX3232", "MAX3232", "Package_SO:SOIC-16_3.9x9.9mm_P1.27mm",
     {"1": "C1P", "3": "C1N", "4": "C2P", "5": "C2N", "2": "VSP", "6": "VSN", "16": "+3V3", "15": "GND",
      "11": "RS232_TX", "12": "RS232_RX", "14": "RS232_TXD", "13": "RS232_RXD",
      "10": "GND", "7": "NC", "8": "NC", "9": "NC"}, mpn="TI MAX3232ECDR", desc="RS-232, UART4")
Cap("C13", "100nF", "C1P", "C1N"); Cap("C14", "100nF", "C2P", "C2N")
Cap("C15", "100nF", "VSP", "GND"); Cap("C16", "100nF", "VSN", "GND"); Cap("C17", "100nF", "+3V3", "GND")
comp("J5", "Connector_Generic:Conn_01x03", "RS232", MC % (3, 3), {"1": "RS232_TXD", "2": "RS232_RXD", "3": "GND"},
     mpn="Phoenix 1844223; plug 1840379", desc="RS-232 TXD(out)/RXD(in)/GND")

# ================================================================ flags, holes
comp("#FLG01", "power:PWR_FLAG", "PWR_FLAG", "", {"1": "+24V"})
comp("#FLG02", "power:PWR_FLAG", "PWR_FLAG", "", {"1": "GND"})
comp("#FLG03", "power:PWR_FLAG", "PWR_FLAG", "", {"1": "+3V3"})
comp("#FLG04", "power:PWR_FLAG", "PWR_FLAG", "", {"1": "+24V_ESTOP"})
comp("#FLG05", "power:PWR_FLAG", "PWR_FLAG", "", {"1": "+24V_SAFE"})
for i in range(4):
    comp(f"H{i+1}", "Mechanical:MountingHole", "M3", "MountingHole:MountingHole_3.2mm_M3", {}, desc="M3 mounting hole")
