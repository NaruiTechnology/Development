import sys
import asyncio
import logging
logger = logging.getLogger()

import numpy as np
from PyQt6.QtCore import Qt, QSize
from PyQt6.QtCore import QThread, QObject, pyqtSignal, pyqtSlot as Slot
from PyQt6.QtGui import QFont, QDoubleValidator
from PyQt6.QtWidgets import (QHBoxLayout, QMainWindow, QDialog, QProgressBar,
                             QMessageBox, QPushButton, QComboBox, QCheckBox,
                             QVBoxLayout, QWidget, QLabel, QGridLayout,
                             QSpinBox, QFileDialog, QLineEdit, QDialogButtonBox, QToolBar,
                             QDockWidget, QSizePolicy, QTabWidget, QFormLayout, QGroupBox)
import pyqtgraph as pg

import qasync
from qasync import asyncSlot, asyncClose, QApplication, QEventLoop

from obi.gui import ImageDisplay, CombinedScanControls, CombinedPatternControls, BeamControl, MagCalWidget

from obi.transfer import TCPConnection, setup_logging, TransferError
from obi.macros import FrameBuffer, BitmapVectorPattern
from obi.config.meta import ScopeSettings

from obi.commands import *

from obi.sysControl.stepper.controlStepperInterface import ControlStepperInterface

setup_logging({"Stream": logging.DEBUG, "Command": logging.DEBUG, "Connection": logging.DEBUG})


class ScanControlWidget(QDockWidget):
    def __init__(self):
        super().__init__(
            windowTitle="Picture Control", 
            features = QDockWidget.DockWidgetFeature.DockWidgetMovable |
                        QDockWidget.DockWidgetFeature.DockWidgetFloatable
        )
        self.inner = CombinedScanControls()
        self.setWidget(self.inner)
        
class BeamStateWidget(QDockWidget):
    def __init__(self, conn, beams):
        super().__init__(
            windowTitle="Beam State", 
            features = QDockWidget.DockWidgetFeature.DockWidgetMovable |
                        QDockWidget.DockWidgetFeature.DockWidgetFloatable
        )
        self.inner = BeamControl(conn, beams)
        self.setWidget(self.inner)


class PatternControlWidget(QDockWidget):
    def __init__(self, conn):
        super().__init__(
            windowTitle="Pattern Control", 
            features = QDockWidget.DockWidgetFeature.DockWidgetMovable |
                        QDockWidget.DockWidgetFeature.DockWidgetFloatable
        )
        self.inner = CombinedPatternControls(conn)
        self.setWidget(self.inner)

class Tools(QToolBar):
    def __init__(self):
        super().__init__()
        self.calibrate = self.addAction("Calibrate")
        self.debug = self.addAction("???")
        self.setFont(QFont('Arial', 14)) 
        

class Window(QMainWindow):
    _logger = logging.getLogger("GUI")
    beam_enum = {"electron": BeamType.Electron, "ion": BeamType.Ion}

    def __init__(self):
        super().__init__()
        self.scope_settings = ScopeSettings.from_toml_file("microscope.toml")
        ep = self.scope_settings.endpoint
        print(ep)
        if ep is None:
            self.conn = TCPConnection("localhost", 2224)
        else:
            host = ep.host or "localhost"
            port = ep.port
            self.conn = TCPConnection(host, port)

        self.fb = FrameBuffer(self.conn)

        # Create the tab widget
        self.tabs = QTabWidget()
        self.setCentralWidget(self.tabs)

        # Add existing widgets to the first tab
        self.main_tab = QWidget()
        self.tabs.addTab(self.main_tab, "Main Controls")
        self.setup_main_tab()

        # Add stepper control to the second tab
        self.stepper_tab = QWidget()
        self.tabs.addTab(self.stepper_tab, "Stepper Control")
        self.setup_stepper_tab()

    def setup_main_tab(self):
        """Set up the Main Controls tab with left-right horizontal layout."""
        layout = QHBoxLayout()  # Horizontal layout for left and right groups

        # Left Group: Contains the remaining widgets
        left_group = QGroupBox("Left Panel")
        left_layout = QVBoxLayout()
        self.image_display = ImageDisplay(511, 511)
        left_layout.addWidget(self.image_display)
        left_group.setLayout(left_layout)

        # Right Group: Contains Beam Status, Photo Controls, and Pattern Control
        right_group = QGroupBox("Right Panel")
        right_layout = QVBoxLayout()

        self.beam_control = BeamStateWidget(self.conn, self.scope_settings.beam_settings)
        self.scan_control = ScanControlWidget()
        self.pattern_control = PatternControlWidget(self.conn)

        right_layout.addWidget(self.beam_control)
        right_layout.addWidget(self.scan_control)
        right_layout.addWidget(self.pattern_control)
        right_group.setLayout(right_layout)

        # Add both groups to the main layout
        layout.addWidget(left_group)
        layout.addWidget(right_group)

        self.main_tab.setLayout(layout)

    def setup_stepper_tab(self):
        """Set up the Stepper Control tab with updated layout."""
        layout = QHBoxLayout()  # Horizontal layout for left and right groups

        # Left Group: X/Y configuration input, Current Position, and Progress Bar
        config_group = QGroupBox("Target Position")
        config_layout = QVBoxLayout()  # Vertical layout for inputs and bottom widgets

        # X/Y Configuration Input
        input_layout = QHBoxLayout()  # Horizontal layout for X/Y inputs
        self.x_input = QLineEdit()
        self.y_input = QLineEdit()
        self.x_input.setPlaceholderText("Enter target X position")
        self.y_input.setPlaceholderText("Enter target Y position")
        self.x_input.setValidator(QDoubleValidator())  # Validate float input
        self.y_input.setValidator(QDoubleValidator())  # Validate float input

        input_layout.addWidget(QLabel("X Position:"))
        input_layout.addWidget(self.x_input)
        input_layout.addWidget(QLabel("Y Position:"))
        input_layout.addWidget(self.y_input)
        config_layout.addLayout(input_layout)

        # Add margin between Target Position and Current Position
        config_layout.addSpacing(50)  # Add 50 pixels of space

        # Current Position
        current_position_layout = QHBoxLayout()  # Horizontal layout for Current X/Y positions
        current_position_layout.addWidget(QLabel("Current X Position:"))
        self.current_x_label = QLabel("X: 0.0")
        current_position_layout.addWidget(self.current_x_label)
        current_position_layout.addWidget(QLabel("Current Y Position:"))
        self.current_y_label = QLabel("Y: 0.0")
        current_position_layout.addWidget(self.current_y_label)
        config_layout.addLayout(current_position_layout)

        # Progress Bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 100)  # Example range
        self.progress_bar.setValue(0)  # Initial value
        self.progress_bar.setTextVisible(False)  # Hide percentage text
        self.progress_bar.setStyleSheet("QProgressBar::chunk { background-color: green; }")  # Green color bar
        config_layout.addWidget(self.progress_bar)

        config_group.setLayout(config_layout)
        layout.addWidget(config_group)

        # Right Group: Apply button and control buttons
        control_group = QGroupBox("Stepper Motor Controls")
        control_layout = QVBoxLayout()

        # Apply Button
        self.apply_button = QPushButton("Apply")
        self.apply_button.setFixedSize(150, 40)  # Set button size
        self.apply_button.setStyleSheet("text-align: center;")  # Align text to center
        self.apply_button.clicked.connect(self.apply_target_position)
        control_layout.addWidget(self.apply_button, alignment=Qt.AlignmentFlag.AlignTop)
        control_layout.addSpacing(200)  # Add 200 pixels of space below the Apply button

        # Control Buttons
        button_group = QGroupBox()  # Group buttons together
        button_layout = QVBoxLayout()
        button_layout.setSpacing(10)  # Add 10 pixels between buttons

        self.home_button = QPushButton("Home")
        self.start_button = QPushButton("Start")
        self.pause_button = QPushButton("Pause")
        self.resume_button = QPushButton("Resume")
        self.stop_button = QPushButton("Stop")

        # Set button size and align text to center
        for button in [self.home_button, self.start_button, self.pause_button, self.resume_button, self.stop_button]:
            button.setFixedSize(150, 40)
            button.setStyleSheet("text-align: center;")

        self.home_button.clicked.connect(self.home_stepper)
        self.start_button.clicked.connect(self.start_stepper)
        self.pause_button.clicked.connect(self.pause_stepper)
        self.resume_button.clicked.connect(self.resume_stepper)
        self.stop_button.clicked.connect(self.stop_stepper)

        button_layout.addWidget(self.home_button)
        button_layout.addWidget(self.start_button)
        button_layout.addWidget(self.pause_button)
        button_layout.addWidget(self.resume_button)
        button_layout.addWidget(self.stop_button)

        button_layout.addStretch()  # Push buttons to the bottom
        button_group.setLayout(button_layout)
        control_layout.addWidget(button_group)

        control_group.setLayout(control_layout)
        layout.addWidget(control_group)

        self.stepper_tab.setLayout(layout)

        # Initialize stepper interface
        self.stepper_interface = ControlStepperInterface(self.conn, logger)

    def apply_target_position(self):
        """Apply the target X/Y position with validation."""
        try:
            x_target = float(self.x_input.text())
            y_target = float(self.y_input.text())
            QMessageBox.information(self, "Target Position Applied", f"X: {x_target}, Y: {y_target}")
        except ValueError:
            QMessageBox.warning(self, "Invalid Input", "Please enter valid numeric values for X and Y positions.")

    @asyncSlot()
    async def home_stepper(self):
        """Reset the stepper motor to the origin point."""
        await self.stepper_interface.enable()
        await self.stepper_interface.run_steps(0)  # Reset to origin
        await self.stepper_interface.disable()
        self.update_current_position(0.0, 0.0)

    @asyncSlot()
    async def start_stepper(self):
        """Start moving the stepper motor to the target position."""
        try:
            x_target = float(self.x_input.text())
            y_target = float(self.y_input.text())
        except ValueError:
            QMessageBox.warning(self, "Invalid Input", "Please enter valid numeric values for X and Y positions.")
            return

        await self.stepper_interface.enable()
        # Assuming `run_steps` moves the motor to the target position
        await self.stepper_interface.run_steps(int(x_target))
        await self.stepper_interface.run_steps(int(y_target))
        self.update_current_position(x_target, y_target)

    @asyncSlot()
    async def pause_stepper(self):
        """Pause the stepper motor."""
        await self.stepper_interface.run_continuous(False)

    @asyncSlot()
    async def resume_stepper(self):
        """Resume the stepper motor."""
        await self.stepper_interface.run_continuous(True)

    @asyncSlot()
    async def stop_stepper(self):
        """Stop the stepper motor."""
        await self.stepper_interface.disable()

    def update_current_position(self, x, y):
        """Update the current X/Y position labels."""
        self.current_x_label.setText(f"X: {x}")
        self.current_y_label.setText(f"Y: {y}")

    def printstuff(self):
        from rich import print
        def describe(obj):
            print(obj)
            print(obj.size())
            print(obj.sizeHint())
            print(obj.sizePolicy().horizontalPolicy(),obj.sizePolicy().verticalPolicy())
        describe(self)
        #describe(self.image_display)
        describe(self.mag_cal.inner.table)

        #print(self.image_display.image_view.windowFrameRect())

    # def sizeHint(self):
    #     return self.screen().availableGeometry().size()

    def init_ui(self):
        self.scan_control.inner.photo.acq_btn.to_paused_state(self.acquire_photo)
        self.scan_control.inner.live.start_btn.to_paused_state(self.toggle_live_scan)
        self.enable_all_controls()

    @Slot(ScopeSettings)
    def update_toml(self, settings:ScopeSettings):
        self.scope_settings = settings
        self.scope_settings.to_toml_file() #write out to microscope.toml
    
    def open_calibration(self):
        self.mag_cal.inner.pass_toml(self.scope_settings)
        beam = self.beam_control.inner.get_current_beam()
        if beam is not None:
            self.mag_cal.inner.set_beam(beam)
        if self.fb.current_frame is not None:
            self.mag_cal.inner.resolution = max(self.fb.current_frame._x_count, self.fb.current_frame._y_count)
        self.mag_cal.show()
        
    def ensure_unique_control(self, control_item):
        for item in self.unique_controllers:
            if item != control_item:
                item.setEnabled(False)
    def enable_all_controls(self):
        for item in self.unique_controllers:
            item.setEnabled(True)

    async def capture_ROI(self, resolution, dwell_time):
        x_start, x_count, y_start, y_count = self.image_display.get_ROI()
        print(f"{resolution=}, {x_start=}, {x_count=}, {y_start=}, {y_count=}")
        async for frame in self.fb.capture_frame_roi(
            x_res=resolution, y_res=resolution,
            x_start = x_start, x_count = x_count, y_start = y_start, y_count = y_count,
            dwell_time=dwell_time, latency=65536
        ):
            self.image_display.setImage(frame.as_uint8())
            self._logger.debug("set image ROI")


    async def capture_frame(self, resolution, dwell_time):
        if self.image_display.roi is not None:
            if (self.fb.current_frame is not None) & (resolution != max(self.fb.current_frame._x_count, self.fb.current_frame._y_count)):
                self.image_display.remove_ROI()
                self.scan_control.inner.live.roi_btn.setChecked(False)
            else:
                await self.capture_ROI(resolution, dwell_time)
        else:
            async for frame in self.fb.capture_full_frame(
                x_res=resolution, y_res=resolution, dwell_time=dwell_time, latency=65536
                ):
                self.image_display.setImage(frame.as_uint8())
                self._logger.debug("set image")
    
    @asyncSlot()
    async def acquire_photo(self):
        self.scan_control.inner.photo.acq_btn.to_live_state(self.fb.abort_scan)
        resolution, dwell_time = self.scan_control.inner.photo.getval()

        await self.conn.transfer(ExternalCtrlCommand(enable=True))

        try:  
            await self.capture_frame(resolution, dwell_time)
        except TransferError:
            self.init_ui()
            return

        self.scan_control.inner.photo.acq_btn.to_paused_state(self.acquire_photo)
        self.ensure_unique_control(self.scan_control.inner.photo)
        print(f"capture done! {self.fb.is_aborted=}")

        await self.conn.transfer(ExternalCtrlCommand(enable=self.beam_control.inner.ext.isChecked()))

        # if not self.fb.is_aborted:
        print("time to save the image!")
        path = self.scan_control.inner.photo.file.path()
        self.fb.current_frame.saveImage_tifffile(path)
        self.enable_all_controls()



    @asyncSlot()
    async def toggle_live_scan(self):
        self.scan_control.inner.live.start_btn.to_live_state(self.fb.abort_scan)
        self.ensure_unique_control(self.scan_control.inner.live)

        await self.conn.transfer(ExternalCtrlCommand(enable=True))
        
        try:     
            while not self.fb.is_aborted:
                resolution, dwell_time = self.scan_control.inner.live.getval()
                await self.capture_frame(resolution, dwell_time)
        except TransferError:
            print("error!")
            self.init_ui()
            return

        
        await self.conn.transfer(ExternalCtrlCommand(enable=self.beam_control.inner.ext.isChecked()))
        
        self.scan_control.inner.live.start_btn.to_paused_state(self.toggle_live_scan)
        self.enable_all_controls()
        print("done")

    def toggle_roi_scan(self):
        if self.scan_control.inner.live.roi_btn.isChecked():
            self.image_display.add_ROI()
        else: 
            self.image_display.remove_ROI()

def run_gui():
    app = QApplication(sys.argv)

    event_loop = QEventLoop(app)
    asyncio.set_event_loop(event_loop)

    app_close_event = asyncio.Event()
    app.aboutToQuit.connect(app_close_event.set)

    window = Window()
    window.show()

    with event_loop:
        event_loop.run_until_complete(app_close_event.wait())


if __name__ == "__main__":
    run_gui()