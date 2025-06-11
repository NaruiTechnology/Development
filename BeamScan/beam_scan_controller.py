import threading
from typing import List, Tuple
from dataclasses import dataclass
from glasgow_scan_interface_sim import GlasgowScanInterface

@dataclass
class ScanPoint:
    electron_volts: float
    z_value: float
    xy_position: Tuple[float, float]
    reflection_value: float = 0.0

class BeamScanController:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls, *args, **kwargs):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(BeamScanController, cls).__new__(cls)
        return cls._instance

    def __init__(self):
        if hasattr(self, '_initialized') and self._initialized:
            return
        self._initialized = True

        self.scan_data: List[ScanPoint] = []
        self._scan_event = threading.Event()
        self._pause_event = threading.Event()
        self._stop_event = threading.Event()

        self.scan_interface = GlasgowScanInterface()

    def start_scan(self):
        print("[SYSTEM] Scan started.")
        self._scan_event.set()
        self._pause_event.clear()
        self._stop_event.clear()
        threading.Thread(target=self._execute_scan, daemon=True).start()

    def pause_scan(self):
        print("[SYSTEM] Scan paused.")
        self._pause_event.set()

    def stop_scan(self):
        print("[SYSTEM] Scan stopped.")
        self._stop_event.set()
        self._scan_event.clear()
        self._pause_event.clear()

    def _execute_scan(self):
        for point in self.scan_data:
            if self._stop_event.is_set():
                break
            while self._pause_event.is_set():
                print("[SYSTEM] Paused... waiting...")
                threading.Event().wait(0.5)

            self.scan_interface.send_scan_point(*point.xy_position, point.electron_volts)
            point.reflection_value = self.scan_interface.read_reflection()
            print(f"[DATA] Point {point.xy_position} eV={point.electron_volts} Z={point.z_value} -> Reflection={point.reflection_value}")

        print("[SYSTEM] Scan finished.")

if __name__ == "__main__":
    controller = BeamScanController()
    controller.scan_data = [
        ScanPoint(1.5, 0.1, (0.0, 0.0)),
        ScanPoint(1.6, 0.1, (0.1, 0.1)),
        ScanPoint(1.7, 0.1, (0.2, 0.2)),
        ScanPoint(1.8, 0.1, (0.3, 0.3)),
    ]
    controller.start_scan()
