import sys
import numpy as np
import threading
import time

from BeamScanner import BeamScanner

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
        self.scan_active = False
        self.scan_paused = False
        self.stop_requested = False
        self.hardware_enabled = False
        self.update_queue = []
        self._init_ui()
        self.timer = QTimer()
        self.timer.timeout.connect(self._periodic_update)
        self.timer.start(100)

    def _init_ui(self):
        main_widget = QWidget()
        main_layout = QVBoxLayout()

        # --- Input panel: arrange all input widgets horizontally ---
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

        # --- Control buttons ---
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

        # --- Visualization panel ---
        vis_panel = QWidget()
        vis_panel_layout = QHBoxLayout(vis_panel)

        # Scatter map group
        scatter_group = QGroupBox("Pattern Scan Map")
        scatter_layout = QVBoxLayout()
        self.scatter_fig, self.scatter_ax = plt.subplots(figsize=(6, 5))
        self.scatter_canvas = FigureCanvas(self.scatter_fig)
        scatter_layout.addWidget(self.scatter_canvas)
        scatter_group.setLayout(scatter_layout)
        vis_panel_layout.addWidget(scatter_group)

        # Set default scatter map axes to match default width and height
        default_width = float(dict(params)["Width"])
        default_height = float(dict(params)["Height"])
        self.scatter_ax.set_xlim(0, default_width)
        self.scatter_ax.set_ylim(default_height, 0)  # Invert Y for image-like orientation
        self.scatter_ax.set_aspect('equal')
        self.scatter_ax.set_facecolor('white')
        for item in ([self.scatter_ax.title, self.scatter_ax.xaxis.label, self.scatter_ax.yaxis.label] +
                     self.scatter_ax.get_xticklabels() + self.scatter_ax.get_yticklabels()):
            item.set_fontsize(8)

        main_layout.addWidget(vis_panel)

        main_widget.setLayout(main_layout)
        self.setCentralWidget(main_widget)
        self._scatter_plot = None  # For efficient updating
        self.scatter_points = []  # store (x, y) tuples as scan progresses

    def _periodic_update(self):
        # No heatmap update needed, only scatter map is used
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
        self.hardware_enabled = True
        self.connect_btn.setText("Hardware Connected")
        self.connect_btn.setEnabled(False)
        print("Glasgow hardware connected")

    def start_scan(self):
        if self.scan_active:
            return
        params = self.get_parameters()
        self.scanner = BeamScanner(**params)
        rows, cols = self.scanner.get_scan_dimensions()
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

        # Prepare scatter data arrays (preallocate for all points)
        x_vals = pattern[:, :, 0].flatten()
        y_vals = pattern[:, :, 1].flatten()
        x_min, x_max = np.min(x_vals), np.max(x_vals)
        y_min, y_max = np.min(y_vals), np.max(y_vals)
        self.scatter_ax.clear()
        self.scatter_ax.set_facecolor('white')
        self.scatter_ax.set_title("Pattern Matrix Scatter Map")
        self.scatter_ax.set_xlabel("X (eV)")
        self.scatter_ax.set_ylabel("Y (eV)")
        self.scatter_ax.set_xlim(x_min, x_max)
        self.scatter_ax.set_ylim(y_max, y_min)
        self.scatter_ax.set_aspect('equal')
        self._scatter_plot = self.scatter_ax.scatter([], [], c='black', s=10, edgecolors='none')
        self.scatter_canvas.draw_idle()
        self.scatter_points = []
        idx = 0
        for i in range(rows):
            j_range = range(cols) if i % 2 == 0 else range(cols - 1, -1, -1)
            for j in j_range:
                if self.stop_requested:
                    break

                while self.scan_paused and not self.stop_requested:
                    time.sleep(1)

                x_ev, y_ev = pattern[i, j, 0], pattern[i, j, 1]

                if self.hardware_enabled:
                    self._send_to_glasgow(x_ev, y_ev)

                time.sleep(self.scanner.dwell_time / 1000.0)
                reflection = self._get_reflection_value(i, j)
                reflection *= self.scanner.scale_to_ev
                self.scanner.pattern_matrix[i, j, 2] = reflection

                print(f"({i}, {j}) - X: {x_ev:.2f} eV, Y: {y_ev:.2f} eV, Reflection: {reflection: .2f} eV")

                # Append to scatter plot points
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

    def _send_to_glasgow(self, x_ev, y_ev):
        pass  # Hardware integration placeholder

    def _get_reflection_value(self, i, j):
        # This function is kept for compatibility, but not used for heatmap anymore
        return 0

def main():
    app = QApplication(sys.argv)
    window = ESMScanController()
    window.resize(900, 700)
    window.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
