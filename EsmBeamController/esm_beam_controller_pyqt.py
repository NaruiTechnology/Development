import sys
import numpy as np
import threading
import time
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QFormLayout,
    QLabel, QLineEdit, QPushButton, QGroupBox, QGridLayout
)
from PyQt6.QtCore import QTimer
from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg as FigureCanvas
import matplotlib.pyplot as plt

class BeamScanner:
    def __init__(self, x_start, y_start, width, height, step_size, dwell_time, scale_to_ev):
        self.x_start = x_start
        self.y_start = y_start
        self.width = width
        self.height = height
        self.step_size = step_size
        self.dwell_time = dwell_time
        self.scale_to_ev = scale_to_ev
        self.rows = int(height / step_size)
        self.cols = int(width / step_size)
        self.pattern_matrix = self._generate_scan_pattern()
    def _generate_scan_pattern(self):
        matrix = np.zeros((self.rows, self.cols, 3), dtype=np.float32)
        for y_index in range(self.rows):
            y_pos = self.y_start + y_index * self.step_size
            if y_index % 2 == 0:
                for x_index in range(self.cols):
                    x_pos = self.x_start + x_index * self.step_size
                    x_ev, y_ev = self._convert_to_ev(x_pos, y_pos)
                    matrix[y_index, x_index, 0] = x_ev
                    matrix[y_index, x_index, 1] = y_ev
                    matrix[y_index, x_index, 2] = 0.0
            else:
                for x_index in range(self.cols-1, -1, -1):
                    x_pos = self.x_start + x_index * self.step_size
                    x_ev, y_ev = self._convert_to_ev(x_pos, y_pos)
                    matrix[y_index, x_index, 0] = x_ev
                    matrix[y_index, x_index, 1] = y_ev
                    matrix[y_index, x_index, 2] = 0.0
        return matrix
    def _convert_to_ev(self, x, y):
        return (x * self.scale_to_ev, y * self.scale_to_ev)
    def get_scan_dimensions(self):
        return (self.rows, self.cols)
    def get_pattern_matrix(self):
        return self.pattern_matrix

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
        # Input panel
        self.entries = {}
        input_group = QGroupBox("Scan Parameters")
        form = QFormLayout()
        params = [
            ("x_start", 0.0), ("y_start", 0.0), ("Width", 100.0), ("Height", 100.0),
            ("Step", 1.0), ("Dwell", 10.0), ("Scale", 0.1)
        ]
        for label, default in params:
            le = QLineEdit(str(default))
            self.entries[label] = le
            form.addRow(f"{label}:", le)
        input_group.setLayout(form)
        main_layout.addWidget(input_group)
        # Control buttons
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
        # Visualization
        vis_group = QGroupBox("Scan Visualization")
        vis_layout = QVBoxLayout()
        self.fig, self.ax = plt.subplots(figsize=(6, 5))
        self.canvas = FigureCanvas(self.fig)
        vis_layout.addWidget(self.canvas)
        self.heatmap_data = np.zeros((10, 10), dtype=np.uint8)
        self.heatmap = self.ax.imshow(
            self.heatmap_data, cmap='gray', vmin=0, vmax=255,
            interpolation='nearest', origin='lower')
        self.fig.colorbar(self.heatmap, ax=self.ax, label='Intensity')
        self.ax.set_title("ESM Scan Heatmap")
        self.ax.set_xlabel("X Position")
        self.ax.set_ylabel("Y Position")
        vis_group.setLayout(vis_layout)
        main_layout.addWidget(vis_group)
        main_widget.setLayout(main_layout)
        self.setCentralWidget(main_widget)
    def _periodic_update(self):
        while self.update_queue:
            i, j, value = self.update_queue.pop(0)
            if self.heatmap_data is not None:
                self.heatmap_data[i, j] = value
                self.heatmap.set_data(self.heatmap_data)
        if self.heatmap_data is not None:
            self.heatmap.autoscale()
            self.canvas.draw_idle()
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
        self.heatmap_data = np.zeros((rows, cols), dtype=np.uint8)
        self.heatmap.set_data(self.heatmap_data)
        self.ax.set_xlim(-0.5, cols-0.5)
        self.ax.set_ylim(-0.5, rows-0.5)
        self.canvas.draw_idle()
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
        for i in range(rows):
            if self.stop_requested:
                break
            for j in range(cols):
                while self.scan_paused and not self.stop_requested:
                    time.sleep(0.1)
                if self.stop_requested:
                    break
                x_ev, y_ev = pattern[i, j, 0], pattern[i, j, 1]
                if self.hardware_enabled:
                    self._send_to_glasgow(x_ev, y_ev)
                time.sleep(self.scanner.dwell_time / 1000.0)
                reflection = self._get_reflection_value(i, j)
                reflection *= self.scanner.scale_to_ev
                self.scanner.pattern_matrix[i, j, 2] = reflection
                print(f"({i}, {j}) - X: {x_ev:.2f} eV, Y: {y_ev:.2f} eV, Reflection: {reflection: .2f} eV")
                self.update_queue.append((i, j, reflection))
        self.scan_active = False
        self._reset_ui_state()
    def _send_to_glasgow(self, x_ev, y_ev):
        pass  # Hardware integration placeholder
    def _get_reflection_value(self, i, j):
        center_i, center_j = self.heatmap_data.shape[0]//2, self.heatmap_data.shape[1]//2
        distance = np.sqrt((i - center_i)**2 + (j - center_j)**2)
        circle_value = max(0, 200 - distance * 5)
        gradient_value = (i / self.heatmap_data.shape[0]) * 100 + 50
        noise = np.random.randint(-10, 10)
        value = min(255, max(0, int(
            0.4 * circle_value + 
            0.5 * gradient_value + 
            0.1 * noise
        )))
        return value

def main():
    app = QApplication(sys.argv)
    window = ESMScanController()
    window.resize(900, 700)
    window.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
