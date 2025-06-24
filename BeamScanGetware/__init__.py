import argparse
import asyncio
from amaranth import *
from glasgow import applet
from BeamScanGetware.getware import ScanPatternGenerator

try:
    from PyQt6 import QtWidgets, QtGui, QtCore
    from gui import ScanVisualizer
except ImportError:
    QtWidgets = None  # Visualization disabled
    ScanVisualizer = None  # Visualization disabled


class BeamScanApplet(applet.GlasgowApplet):
    help = "Output 2D beam scan pattern over GPIO with visualization"
    description = "Controls GPIO DAC output for electron beam scanning with real-time PyQt6 UI"

    @classmethod
    def add_arguments(cls, parser: argparse.ArgumentParser):
        parser.add_argument("--x-start", type=int, default=0, help="X start coordinate")
        parser.add_argument("--y-start", type=int, default=0, help="Y start coordinate")
        parser.add_argument("--width", type=int, required=True, help="Scan width")
        parser.add_argument("--height", type=int, required=True, help="Scan height")
        parser.add_argument("--step", type=int, default=1, help="Step size")
        parser.add_argument("--dwell", type=int, default=100, help="Dwell time (clock cycles)")
        parser.add_argument("--visualize", action="store_true", help="Enable PyQt6 visualization")

    def build(self, target, args):
        m = Module()
        scan = ScanPatternGenerator()

        m.submodules.scan = scan

        m.d.comb += [
            scan.enable.eq(1),
            scan.dwell_time.eq(args.dwell),
            scan.x_start.eq(args.x_start),
            scan.y_start.eq(args.y_start),
            scan.x_range.eq(args.width),
            scan.y_range.eq(args.height),
            scan.step.eq(args.step),
        ]

        # Output X to GPIO Bank A (A0-A7)
        target.add_subsignal("bank_a", scan.x)
        # Output Y to GPIO Bank B (B0-B7)
        target.add_subsignal("bank_b", scan.y)

        return m

    async def run(self, device, args):
        # Visualization run if requested and PyQt6 available
        if args.visualize and QtWidgets is not None:
            await self.run_visualization(args)
        else:
            print("Scan started without visualization.")
            await asyncio.sleep(10)  # Dummy wait, replace with actual control if needed

    async def run_visualization(self, args):
        app = QtWidgets.QApplication([])

        window = ScanVisualizer(
            width=args.width,
            height=args.height,
            step=args.step,
            dwell=args.dwell,
        )
        window.show()

        # Run Qt event loop alongside asyncio
        loop = asyncio.get_event_loop()
        qt_future = loop.run_in_executor(None, app.exec)
        await qt_future


# class ScanVisualizer(QtWidgets.QWidget):
    # def __init__(self, width, height, step, dwell):
    #     super().__init__()
    #     self.setWindowTitle("Beam Scan Visualization")
    #     self.setMinimumSize(400, 400)

    #     self.width = width
    #     self.height = height
    #     self.step = step
    #     self.dwell = dwell

    #     self.zoom = 4
    #     self.offset = QtCore.QPoint(0, 0)
    #     self.is_panning = False
    #     self.last_pos = None
    #     self.paused = False

    #     self.timer = QtCore.QTimer()
    #     self.timer.timeout.connect(self.update_scan)
    #     self.timer.start(30)  # ~33 FPS

    #     self.x = 0
    #     self.y = 0

    #     self.scan_data = []

    #     self.setFocusPolicy(QtCore.Qt.FocusPolicy.StrongFocus)

    # def update_scan(self):
    #     if self.paused:
    #         return

    #     # Move scan X and Y like the hardware pattern generator
    #     if self.x < self.width - self.step:
    #         self.x += self.step
    #     else:
    #         self.x = 0
    #         if self.y < self.height - self.step:
    #             self.y += self.step
    #         else:
    #             self.y = 0

    #     # Simulate beam intensity with decay and noise
    #     intensity = int(
    #         255 * ((self.x / self.width) * 0.5 + (self.y / self.height) * 0.5)
    #         * (0.8 + 0.2 * (0.5 + 0.5 * QtCore.qrand()))
    #     )
    #     intensity = max(0, min(255, intensity))

    #     self.scan_data.append((self.x, self.y, intensity))
    #     if len(self.scan_data) > 10000:
    #         self.scan_data.pop(0)

    #     self.update()

    # def paintEvent(self, event):
    #     painter = QtGui.QPainter(self)
    #     painter.fillRect(self.rect(), QtCore.Qt.GlobalColor.black)

    #     # Draw scan points
    #     for x, y, intensity in self.scan_data:
    #         px = (x * self.zoom) + self.offset.x()
    #         py = (y * self.zoom) + self.offset.y()
    #         color = QtGui.QColor(intensity, intensity//2, 255 - intensity)
    #         painter.setPen(color)
    #         painter.drawPoint(px, py)

    #     # Overlay scan coordinate text
    #     painter.setPen(QtCore.Qt.GlobalColor.white)
    #     painter.drawText(10, 20, f"X: {self.x}  Y: {self.y}  Dwell: {self.dwell}")

    #     if self.paused:
    #         painter.drawText(10, 40, "Paused (Spacebar to resume)")

    # def wheelEvent(self, event):
    #     delta = event.angleDelta().y() / 120  # steps of wheel
    #     factor = 1.1 ** delta
    #     self.zoom = max(1, min(20, self.zoom * factor))
    #     self.update()

    # def mousePressEvent(self, event):
    #     if event.button() == QtCore.Qt.MouseButton.LeftButton:
    #         self.is_panning = True
    #         self.last_pos = event.pos()

    # def mouseMoveEvent(self, event):
    #     if self.is_panning and self.last_pos:
    #         delta = event.pos() - self.last_pos
    #         self.offset += delta
    #         self.last_pos = event.pos()
    #         self.update()

    # def mouseReleaseEvent(self, event):
    #     if event.button() == QtCore.Qt.MouseButton.LeftButton:
    #         self.is_panning = False
    #         self.last_pos = None

    # def keyPressEvent(self, event):
    #     key = event.key()
    #     if key == QtCore.Qt.Key.Key_Space:
    #         self.paused = not self.paused
    #     elif key == QtCore.Qt.Key.Key_S:
    #         self.save_snapshot()
    #     else:
    #         super().keyPressEvent(event)

    # def save_snapshot(self):
    #     pixmap = self.grab()
    #     fname = f"beam_scan_snapshot.png"
    #     pixmap.save(fname)
    #     print(f"Saved snapshot: {fname}")
