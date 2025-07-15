import sys
import numpy as np
import threading
import random
import time
import asyncio

from BeamScanner import BeamScanner
# from BeamScanner.glasgow_uart_io import GlasgowUARTController
from Software.controller.glasgowUartController import GlasgowUARTController

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QLineEdit, QPushButton, QGroupBox
)
from PyQt6.QtCore import QTimer
from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg as FigureCanvas
import matplotlib.pyplot as plt


class ESMScanController(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("ESM Beam Controller (PyQt6)")
        self.setStyleSheet("background-color: dimgray;")  # Set the background color to dimgray
        self.scan_active = False
        self.scan_paused = False
        self.stop_requested = False
        self.hardware_enabled = False
        self.uart_controller = None
        self.update_queue = []
        self._init_ui()
        self.timer = QTimer()
        self.timer.timeout.connect(self._periodic_update)
        self.timer.start(100)

    def _init_ui(self):
        main_widget = QWidget()
        main_layout = QVBoxLayout()

        self.entries = {}
        input_panel = QWidget()
        input_layout = QHBoxLayout(input_panel)
        params = [
            ("x_start", 0.0), ("y_start", 0.0), ("Width", 100.0), ("Height", 50.0),
            ("Step", 1.0), ("Dwell", 10.0), ("Scale", 0.1)
        ]
        for label, default in params:
            lbl = QLabel(f"{label}:")
            le = QLineEdit(str(default))
            self.entries[label] = le
            input_layout.addWidget(lbl)
            input_layout.addWidget(le)
        main_layout.addWidget(input_panel)

        btn_layout = QHBoxLayout()
        self.start_btn = QPushButton("Start Scan")
        self.start_btn.clicked.connect(self.start_scan)
        btn_layout.addWidget(self.start_btn)
        self.pause_btn = QPushButton("Pause Scan")
        self.pause_btn.setEnabled(False)
        self.pause_btn.clicked.connect(self.toggle_pause)
        btn_layout.addWidget(self.pause_btn)
        self.stop_btn = QPushButton("Stop Scan")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self.stop_scan)
        btn_layout.addWidget(self.stop_btn)
        self.connect_btn = QPushButton("Connect Hardware")
        self.connect_btn.clicked.connect(self.connect_hardware)
        btn_layout.addWidget(self.connect_btn)
        main_layout.addLayout(btn_layout)

        vis_panel = QWidget()
        vis_panel_layout = QHBoxLayout(vis_panel)

        scatter_group = QGroupBox("Pattern Scan Map")
        scatter_layout = QVBoxLayout()
        self.scatter_fig, self.scatter_ax = plt.subplots(figsize=(6, 5))
        self.scatter_canvas = FigureCanvas(self.scatter_fig)
        scatter_layout.addWidget(self.scatter_canvas)
        scatter_group.setLayout(scatter_layout)
        vis_panel_layout.addWidget(scatter_group)

        default_width = float(dict(params)["Width"])
        default_height = float(dict(params)["Height"])
        self.scatter_ax.set_xlim(0, default_width)
        self.scatter_ax.set_ylim(default_height, 0)
        self.scatter_ax.set_aspect('equal')
        self.scatter_ax.set_facecolor('white')
        for item in ([self.scatter_ax.title, self.scatter_ax.xaxis.label, self.scatter_ax.yaxis.label] +
                     self.scatter_ax.get_xticklabels() + self.scatter_ax.get_yticklabels()):
            item.set_fontsize(8)

        main_layout.addWidget(vis_panel)

        main_widget.setLayout(main_layout)
        self.setCentralWidget(main_widget)
        self._scatter_plot = None
        self.scatter_points = []

    def _periodic_update(self):
        pass

    def get_parameters(self):
        return {
            'x_start': float(self.entries['x_start'].text()),
            'y_start': float(self.entries['y_start'].text()),
            'width': float(self.entries['Width'].text()),
            'height': float(self.entries['Height'].text()),
            'step_size': float(self.entries['Step'].text()),
            'dwell_time': float(self.entries['Dwell'].text()),
            'scale_to_ev': float(self.entries['Scale'].text())
        }

    def connect_hardware(self):
        try:
            self.uart_controller = GlasgowUARTController(port="A", tx_pin=0, rx_pin=1, baud=9600, serial_number='C3-20241215T152505Z')
            asyncio.run(self.uart_controller.connect())
            self.hardware_enabled = True
            self.connect_btn.setText("Hardware Connected")
            self.connect_btn.setEnabled(False)
            print("Glasgow hardware connected via UART")
        except Exception as e:
            print(f"Error connecting to hardware: {e}")

    def start_scan(self):
        if self.scan_active:
            return
        params = self.get_parameters()
        self.scanner = BeamScanner(**params)
        self.scan_active = True
        self.scan_paused = False
        self.stop_requested = False
        self.start_btn.setEnabled(False)
        self.pause_btn.setEnabled(True)
        self.pause_btn.setText("Pause Scan")
        self.stop_btn.setEnabled(True)
        scan_thread = threading.Thread(target=self._scan_worker)
        scan_thread.daemon = True
        scan_thread.start()

    def toggle_pause(self):
        self.scan_paused = not self.scan_paused
        self.pause_btn.setText("Resume Scan" if self.scan_paused else "Pause Scan")

    def stop_scan(self):
        self.stop_requested = True
        self.scan_active = False
        self._reset_ui_state()

    def _reset_ui_state(self):
        self.start_btn.setEnabled(True)
        self.pause_btn.setEnabled(False)
        self.stop_btn.setEnabled(False)

    def _scan_worker(self):
        pattern = self.scanner.get_pattern_matrix()
        rows, cols, _ = pattern.shape

        x_vals = pattern[:, :, 0].flatten()
        y_vals = pattern[:, :, 1].flatten()
        self.scatter_ax.clear()
        self.scatter_ax.set_facecolor('white')
        self.scatter_ax.set_xlabel("X (eV)")
        self.scatter_ax.set_ylabel("Y (eV)")
        self.scatter_ax.set_xlim(np.min(x_vals), np.max(x_vals))
        self.scatter_ax.set_ylim(np.max(y_vals), np.min(y_vals))
        self.scatter_ax.set_aspect('equal')
        self._scatter_plot = self.scatter_ax.scatter([], [], c='gray', s=10, edgecolors='none')
        self.scatter_canvas.draw_idle()
        self.scatter_points = []

        for i in range(rows):
            j_range = range(cols) if i % 2 == 0 else range(cols - 1, -1, -1)
            for j in j_range:
                if self.stop_requested:
                    break

                x_ev, y_ev = pattern[i, j, 0], pattern[i, j, 1]

                if self.hardware_enabled and self.uart_controller:
                    try:
                        asyncio.run(self.uart_controller.send(bytes([int(x_ev) & 0xFF, int(y_ev) & 0xFF])))
                    except Exception as e:
                        print(f"Failed to send to Glasgow: {e}")

                time.sleep(self.scanner.dwell_time / 1000.0)
                reflection = self._get_reflection_value(i, j) * self.scanner.scale_to_ev
                self.scanner.pattern_matrix[i, j, 2] = reflection

                print(f"({i}, {j}) - X: {x_ev:.2f} eV, Y: {y_ev:.2f} eV, Reflection: {reflection: .2f} eV")

                self.scatter_points.append((x_ev, y_ev))
                self._update_scatter_map()

        self.scan_active = False
        self.start_btn.setEnabled(True)
        self.pause_btn.setEnabled(False)
        self.stop_btn.setEnabled(False)

    def _update_scatter_map(self):
        if not self._scatter_plot or not self.scatter_points:
            return
        offsets = np.array(self.scatter_points)
        self._scatter_plot.set_offsets(offsets)
        self.scatter_canvas.draw_idle()

    def _get_reflection_value(self, i=None, j=None):
        randVal = random.randint(0, 9)
        width = float(self.entries['Width'].text())
        height = float(self.entries['Height'].text())
        width = width if width != 0 else 1
        height = height if height != 0 else 1

        if i is not None and j is not None:
            x = i / width
            y = j / height
            intensity = int(
                255 * ((x * 0.5 + y * 0.5) * (0.8 + 0.2 * (0.5 + 0.5 * randVal)))
            )
            return max(0, min(255, intensity))
        return 0

def main():
    app = QApplication(sys.argv)
    window = ESMScanController()
    window.resize(900, 700)
    window.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
