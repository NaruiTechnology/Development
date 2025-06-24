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