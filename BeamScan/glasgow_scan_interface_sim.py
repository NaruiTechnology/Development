import random
import math

class GlasgowScanInterface:
    def __init__(self):
        print("[SIM] Glasgow hardware initialized (simulated).")

    def send_scan_point(self, x: float, y: float, eV: float):
        print(f"[SIM] Sending scan point -> x={x}, y={y}, eV={eV}")

    def read_reflection(self) -> float:
        # Simulate reflection signal with noise
        base_signal = math.sin(random.uniform(0, 2 * math.pi)) * 0.5 + 0.5
        noise = random.uniform(-0.05, 0.05)
        reflection = round(base_signal + noise, 4)
        print(f"[SIM] Reading reflection -> value={reflection}")
        return reflection

    def close(self):
        print("[SIM] Glasgow interface closed.")
