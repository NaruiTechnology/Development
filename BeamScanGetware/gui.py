import logging
import random
try:
    from PyQt6 import QtWidgets, QtGui, QtCore
except ImportError:
    QtWidgets = None  # Visualization disabled

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ScanVisualizer(QtWidgets.QWidget):
    def __init__(self, width, height, step, dwell):
        super().__init__()
        self.setWindowTitle("Beam Scan Visualization")
        self.setMinimumSize(400, 400)
        self.setStyleSheet("background-color: white;")

        # --- Existing scan parameters ---
        self.width = width
        self.height = height
        self.step = step
        self.dwell = dwell

        self.zoom = 4
        self.offset = QtCore.QPoint(0, 0)
        self.is_panning = False
        self.last_pos = None
        self.paused = False

        self.timer = QtCore.QTimer()
        self.timer.timeout.connect(self.update_scan)
        self.timer.start(30)  # ~33 FPS

        self.x = 0
        self.y = 0

        self.scan_data = []

        self.setFocusPolicy(QtCore.Qt.FocusPolicy.StrongFocus)

        # --- Add input widgets for parameters (moved to bottom) ---
        self.input_panel = QtWidgets.QWidget(self)
        self.input_panel.setStyleSheet("background-color: dimgray; color: white;")
        self.input_layout = QtWidgets.QHBoxLayout(self.input_panel)
        self.input_panel.setFixedHeight(50)

        self.width_input = QtWidgets.QSpinBox()
        self.width_input.setRange(10, 5000)
        self.width_input.setValue(width)
        self.width_input.setPrefix("Width (microns): ")
        self.input_layout.addWidget(self.width_input)

        self.height_input = QtWidgets.QSpinBox()
        self.height_input.setRange(10, 5000)
        self.height_input.setValue(height)
        self.height_input.setPrefix("Height: ")
        self.input_layout.addWidget(self.height_input)

        self.step_input = QtWidgets.QSpinBox()
        self.step_input.setRange(1, 500)
        self.step_input.setValue(step)
        self.step_input.setPrefix("Step (microns): ")
        self.input_layout.addWidget(self.step_input)

        self.dwell_input = QtWidgets.QDoubleSpinBox()
        self.dwell_input.setRange(0.01, 10.0)
        self.dwell_input.setSingleStep(0.01)
        self.dwell_input.setValue(dwell)
        self.dwell_input.setPrefix("Dwell(ms): ")
        self.input_layout.addWidget(self.dwell_input)

        self.apply_btn = QtWidgets.QPushButton("Apply")
        self.input_layout.addWidget(self.apply_btn)
        self.apply_btn.clicked.connect(self.apply_parameters)

        # --- Add scan control buttons ---
        self.start_btn = QtWidgets.QPushButton("Start Scan")
        self.start_btn.setStyleSheet("background-color: green; color: black;")
        self.pause_btn = QtWidgets.QPushButton("Pause Scan")
        self.pause_btn.setStyleSheet("background-color: gold; color: black;")
        self.stop_btn = QtWidgets.QPushButton("Stop Scan")
        self.stop_btn.setStyleSheet("background-color: red; color: black;")

        self.input_layout.addWidget(self.start_btn)
        self.input_layout.addWidget(self.pause_btn)
        self.input_layout.addWidget(self.stop_btn)
        self.start_btn.clicked.connect(self.start_scan)
        self.pause_btn.clicked.connect(self.pause_scan)
        self.stop_btn.clicked.connect(self.stop_scan)

        # Layout for the widget
        self.main_layout = QtWidgets.QVBoxLayout(self)
        self.main_layout.setContentsMargins(0, 0, 0, 0)
        # The scan area will be drawn in the remaining space
        self.main_layout.addStretch(1)  # Add stretch to push input_panel to bottom
        self.main_layout.addWidget(self.input_panel)

    def apply_parameters(self):
        self.width = self.width_input.value()
        self.height = self.height_input.value()
        self.step = self.step_input.value()
        self.dwell = self.dwell_input.value()
        self.x = 0
        self.y = 0
        self.scan_data.clear()
        self.update()

    def update_scan(self):
        if self.paused:
            return
        try:
            # Move scan X and Y like the hardware pattern generator
            if self.x < self.width - self.step:
                self.x += self.step
            else:
                self.x = 0
                if self.y < self.height - self.step:
                    self.y += self.step
                else:
                    self.y = 0

            # Simulate beam intensity with decay and noise
            randVal =  random.randint(0, 99)
            intensity = int(
                255 * ((self.x / self.width) * 0.5 + (self.y / self.height) * 0.5)
                * (0.8 + 0.2 * (0.5 + 0.5 * randVal))
            )
            intensity = max(0, min(255, intensity))

            self.scan_data.append((self.x, self.y, intensity))
            if len(self.scan_data) > 10000:
                self.scan_data.pop(0)
            self.update()
            
        except Exception as e:
            logger.error(f"Error updating scan: {e}")

    def paintEvent(self, event):
        painter = QtGui.QPainter(self)
        painter.fillRect(self.rect(), QtCore.Qt.GlobalColor.black)

        # Draw scan points
        try:
            for x, y, intensity in self.scan_data:
                # TODO: Adjust for zoom and offset
                # px = (x * self.zoom) + self.offset.x()
                # py = (y * self.zoom) + self.offset.y()
                px = x + self.offset.x()
                py = y + self.offset.y()
                # color = QtGui.QColor(intensity, intensity//2, 255 - intensity)
                color = QtCore.Qt.GlobalColor.white
                painter.setPen(color)
                painter.drawPoint(px, py)
        except Exception as e:
            logger.error(f"Error painting scan points: {e}")

        # Overlay scan coordinate text
        painter.setPen(QtCore.Qt.GlobalColor.white)
        painter.drawText(10, 20, f"X: {self.x}  Y: {self.y}  Dwell: {self.dwell}")

        if self.paused:
            painter.drawText(10, 40, "Paused (Spacebar to resume)")

    def wheelEvent(self, event):
        delta = event.angleDelta().y() / 120  # steps of wheel
        factor = 1.1 ** delta
        self.zoom = max(1, min(20, self.zoom * factor))
        self.update()

    def mousePressEvent(self, event):
        if event.button() == QtCore.Qt.MouseButton.LeftButton:
            self.is_panning = True
            self.last_pos = event.pos()

    def mouseMoveEvent(self, event):
        if self.is_panning and self.last_pos:
            delta = event.pos() - self.last_pos
            self.offset += delta
            self.last_pos = event.pos()
            self.update()

    def mouseReleaseEvent(self, event):
        if event.button() == QtCore.Qt.MouseButton.LeftButton:
            self.is_panning = False
            self.last_pos = None

    def keyPressEvent(self, event):
        key = event.key()
        if key == QtCore.Qt.Key.Key_Space:
            self.paused = not self.paused
        elif key == QtCore.Qt.Key.Key_S:
            self.save_snapshot()
        else:
            super().keyPressEvent(event)

    def save_snapshot(self):
        pixmap = self.grab()
        fname = f"beam_scan_snapshot.png"
        pixmap.save(fname)
        print(f"Saved snapshot: {fname}")
        
    def start_scan(self):
        self.paused = False
        self.x = 0
        self.y = 0
        self.scan_data.clear()
        self.timer.start(30)

    def pause_scan(self):
        self.paused = True

    def stop_scan(self):
        self.paused = True
        self.x = 0
        self.y = 0
        self.scan_data.clear()
        self.update()
        
if __name__ == "__main__":
    import sys
    try:
        app = QtWidgets.QApplication(sys.argv)
        app.setStyleSheet("QWidget { background-color: white; }")
        visualizer = ScanVisualizer(width=1000, height=1000, step=5, dwell=0.5)
        visualizer.show()
        sys.exit(app.exec())
    except Exception as e:
        print(f"Error: {e}")