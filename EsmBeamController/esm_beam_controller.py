# esm_beam_controller.py
import tkinter as tk
from tkinter import ttk
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import threading
import time
import queue

class BeamScanner:
    def __init__(self, x_start, y_start, width, height, step_size, dwell_time, scale_to_ev):
        self.x_start = x_start
        self.y_start = y_start
        self.width = width
        self.height = height
        self.step_size = step_size
        self.dwell_time = dwell_time
        self.scale_to_ev = scale_to_ev
        
        # Calculate matrix dimensions
        self.rows = int(height / step_size)
        self.cols = int(width / step_size)
        # pattern_matrix now has 3 values: x_ev, y_ev, reflection
        self.pattern_matrix = self._generate_scan_pattern()
        
    def _generate_scan_pattern(self):
        # Add a third channel for reflection value (init to 0)
        matrix = np.zeros((self.rows, self.cols, 3), dtype=np.float32)
        
        for y_index in range(self.rows):
            y_pos = self.y_start + y_index * self.step_size
            
            if y_index % 2 == 0:  # Even rows: left-to-right
                for x_index in range(self.cols):
                    x_pos = self.x_start + x_index * self.step_size
                    x_ev, y_ev = self._convert_to_ev(x_pos, y_pos)
                    matrix[y_index, x_index, 0] = x_ev
                    matrix[y_index, x_index, 1] = y_ev
                    matrix[y_index, x_index, 2] = 0.0  # reflection value placeholder
            else:  # Odd rows: right-to-left
                for x_index in range(self.cols-1, -1, -1):
                    x_pos = self.x_start + x_index * self.step_size
                    x_ev, y_ev = self._convert_to_ev(x_pos, y_pos)
                    matrix[y_index, x_index, 0] = x_ev
                    matrix[y_index, x_index, 1] = y_ev
                    matrix[y_index, x_index, 2] = 0.0  # reflection value placeholder
        return matrix
    
    def _convert_to_ev(self, x, y):
        # print("(x = {}, Y = {})".format(x, y))
        return (x * self.scale_to_ev, y * self.scale_to_ev)
    
    def get_scan_dimensions(self):
        return (self.rows, self.cols)
    
    def get_pattern_matrix(self):
        return self.pattern_matrix


class ESMScanController:
    def __init__(self, root):
        self.root = root
        self.root.title("ESM Beam Controller")
        
        # Scan control variables
        self.scan_active = False
        self.scan_paused = False
        self.stop_requested = False
        self.update_queue = queue.Queue()
        self.hardware_enabled = False  # Set to True when hardware is connected
        
        # Create UI components
        self._create_input_panel()
        self._create_control_buttons()
        self._create_visualization()
        
        # Start the periodic UI update
        self._periodic_update()
    
    def _create_input_panel(self):
        input_frame = ttk.LabelFrame(self.root, text="Scan Parameters")
        input_frame.pack(padx=10, pady=5, fill=tk.X)
        
        parameters = [
            ("x_start (μm):", 0.0),
            ("y_start (μm):", 0.0),
            ("Width (μm):", 100.0),
            ("Height (μm):", 100.0),
            ("Step Size (μm):", 1.0),
            ("Dwell Time (ms):", 10.0),
            ("Scale (μm→eV):", 0.1)
        ]
        
        self.entries = {}
        for i, (label, default) in enumerate(parameters):
            row = ttk.Frame(input_frame)
            row.pack(fill=tk.X, padx=5, pady=2)
            
            ttk.Label(row, text=label, width=15).pack(side=tk.LEFT)
            entry = ttk.Entry(row)
            entry.insert(0, str(default))
            entry.pack(side=tk.RIGHT, expand=True, fill=tk.X)
            self.entries[label.split()[0]] = entry
    
    def _create_control_buttons(self):
        button_frame = ttk.Frame(self.root)
        button_frame.pack(padx=10, pady=5, fill=tk.X)
        
        self.start_btn = ttk.Button(button_frame, text="Start Scan", command=self.start_scan)
        self.start_btn.pack(side=tk.LEFT, padx=5)
        
        self.pause_btn = ttk.Button(button_frame, text="Pause Scan", command=self.toggle_pause, state=tk.DISABLED)
        self.pause_btn.pack(side=tk.LEFT, padx=5)
        
        self.stop_btn = ttk.Button(button_frame, text="Stop Scan", command=self.stop_scan, state=tk.DISABLED)
        self.stop_btn.pack(side=tk.LEFT, padx=5)
        
        self.connect_btn = ttk.Button(button_frame, text="Connect Hardware", command=self.connect_hardware)
        self.connect_btn.pack(side=tk.RIGHT, padx=5)
    
    def _create_visualization(self):
        vis_frame = ttk.LabelFrame(self.root, text="Scan Visualization")
        vis_frame.pack(padx=10, pady=5, fill=tk.BOTH, expand=True)
        
        self.fig, self.ax = plt.subplots(figsize=(6, 5))
        self.canvas = FigureCanvasTkAgg(self.fig, master=vis_frame)
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)
        
        # Initialize empty heatmap
        self.heatmap_data = np.zeros((10, 10), dtype=np.uint8)
        self.heatmap = self.ax.imshow(
            self.heatmap_data, 
            cmap='gray', 
            vmin=0, 
            vmax=255,
            interpolation='nearest',
            origin='lower'
        )
        self.fig.colorbar(self.heatmap, ax=self.ax, label='Intensity')
        self.ax.set_title("ESM Scan Heatmap")
        self.ax.set_xlabel("X Position")
        self.ax.set_ylabel("Y Position")
    
    def _periodic_update(self):
        """Update visualization from queue data"""
        while not self.update_queue.empty():
            i, j, value = self.update_queue.get()
            if self.heatmap_data is not None:
                self.heatmap_data[i, j] = value
                self.heatmap.set_data(self.heatmap_data)
        
        if self.heatmap_data is not None:
            self.heatmap.autoscale()
            self.canvas.draw_idle()
        
        self.root.after(100, self._periodic_update)
    
    def get_parameters(self):
        """Retrieve parameters from UI inputs"""
        return {
            'x_start': float(self.entries['x_start'].get()),
            'y_start': float(self.entries['y_start'].get()),
            'width': float(self.entries['Width'].get()),
            'height': float(self.entries['Height'].get()),
            'step_size': float(self.entries['Step'].get()),
            'dwell_time': float(self.entries['Dwell'].get()),
            'scale_to_ev': float(self.entries['Scale'].get())
        }
    
    def connect_hardware(self):
        """Simulate hardware connection - would be implemented with Glasgow API"""
        self.hardware_enabled = True
        self.connect_btn.config(text="Hardware Connected", state=tk.DISABLED)
        print("Glasgow hardware connected")
        
        # In a real implementation:
        # self.device = GlasgowDevice().acquire()
        # self.dac = DACApplet(self.device)
        # self.dac.build()
        # self.dac.start(...)
    
    def start_scan(self):
        """Start a new scanning thread"""
        if self.scan_active:
            return
        
        params = self.get_parameters()
        self.scanner = BeamScanner(**params)
        rows, cols = self.scanner.get_scan_dimensions()
        
        # Initialize heatmap
        self.heatmap_data = np.zeros((rows, cols), dtype=np.uint8)
        self.heatmap.set_data(self.heatmap_data)
        self.ax.set_xlim(-0.5, cols-0.5)
        self.ax.set_ylim(-0.5, rows-0.5)
        self.canvas.draw_idle()
        
        # Reset control flags
        self.scan_active = True
        self.scan_paused = False
        self.stop_requested = False
        
        # Update UI state
        self.start_btn.config(state=tk.DISABLED)
        self.pause_btn.config(state=tk.NORMAL, text="Pause Scan")
        self.stop_btn.config(state=tk.NORMAL)
        
        # Start scanning thread
        scan_thread = threading.Thread(target=self._scan_worker)
        scan_thread.daemon = True
        scan_thread.start()
    
    def toggle_pause(self):
        """Toggle pause state"""
        self.scan_paused = not self.scan_paused
        self.pause_btn.config(
            text="Resume Scan" if self.scan_paused else "Pause Scan"
        )
    
    def stop_scan(self):
        """Request scan termination"""
        self.stop_requested = True
        self.scan_active = False
        self._reset_ui_state()
        
        # In a real implementation:
        # self._teardown_glasgow_hardware()
    
    def _reset_ui_state(self):
        """Reset UI after scan completes"""
        self.start_btn.config(state=tk.NORMAL)
        self.pause_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.DISABLED)
    
    def _scan_worker(self):
        """Worker thread that performs scanning"""
        pattern = self.scanner.get_pattern_matrix()
        rows, cols, _ = pattern.shape
        
        for i in range(rows):
            if self.stop_requested:
                break
                
            for j in range(cols):
                while self.scan_paused and not self.stop_requested:
                    time.sleep(0.1)  # Check every 100ms if still paused
                
                if self.stop_requested:
                    break
                
                # Get position in eV
                x_ev, y_ev = pattern[i, j, 0], pattern[i, j, 1]
                
                # Send to hardware if connected
                if self.hardware_enabled:
                    self._send_to_glasgow(x_ev, y_ev)
                
                # Simulate dwell time
                time.sleep(self.scanner.dwell_time / 1000.0)
                
                # Get reflection value
                reflection = self._get_reflection_value(i, j)
                reflection *= self.scanner.scale_to_ev  # Scale to eV

                # Persist reflection value in pattern_matrix
                self.scanner.pattern_matrix[i, j, 2] = reflection
                print(f"({i}, {j}) - X: {x_ev:.2f} eV, Y: {y_ev:.2f} eV, Reflection: {reflection: .2f} eV")
                
                # Update visualization
                self.update_queue.put((i, j, reflection))
                
        # print("--- Print reflection to matrix.")
        # print(self.scanner.pattern_matrix)
        
        self.scan_active = False
        self.root.after(0, self._reset_ui_state)
    
    def _send_to_glasgow(self, x_ev, y_ev):
        """
        Send position data to Glasgow hardware to control electron beam
        
        Implementation for actual hardware:
        1. Convert eV values to DAC voltages using calibration
        2. Set voltages on DAC channels
        3. Trigger beam deflection
        """
        # In a real implementation:
        # volts_x = self._ev_to_volts(x_ev, 'x')
        # volts_y = self._ev_to_volts(y_ev, 'y')
        # self.dac.set_voltage(0, volts_x)  # Channel 0 = X-axis
        # self.dac.set_voltage(1, volts_y)  # Channel 1 = Y-axis
        # self._trigger_beam_deflection()
        pass

    def _ev_to_volts(self, ev_value, axis):
        """
        Convert eV values to DAC voltages using calibration
        (Placeholder for actual calibration implementation)
        """
        # Example calibration parameters (would be configurable)
        calibration = {
            'x': {'offset': 0.1, 'gain': 0.5},
            'y': {'offset': 0.08, 'gain': 0.52}
        }
        cal = calibration[axis]
        volts = cal['offset'] + (ev_value * cal['gain'])
        return max(0.0, min(volts, 3.3))  # Clamp to 0-3.3V range

    def _trigger_beam_deflection(self):
        """
        Trigger beam deflection using GPIO pulse
        (Placeholder for actual hardware implementation)
        """
        # Implementation for actual hardware:
        # self.device.set_gpio(2, True)  # Set trigger pin high
        # time.sleep(0.0001)             # 100 μs pulse width
        # self.device.set_gpio(2, False) # Set trigger pin low
        pass

    def _get_reflection_value(self, i, j):
        """
        Generate simulated reflection values or read from hardware
        
        Creates an interesting pattern for demonstration:
        - Circular feature at center
        - Vertical gradient
        - Random noise
        """
        # Create center coordinates
        center_i, center_j = self.heatmap_data.shape[0]//2, self.heatmap_data.shape[1]//2
        
        # Calculate distance from center
        distance = np.sqrt((i - center_i)**2 + (j - center_j)**2)
        
        # Circle pattern (200 at center, decreasing with distance)
        circle_value = max(0, 200 - distance * 5)
        
        # Gradient pattern (increasing from top to bottom)
        gradient_value = (i / self.heatmap_data.shape[0]) * 100 + 50
        
        # Random noise (simulates measurement noise)
        noise = np.random.randint(-10, 10)
        
        # Combine patterns with weights
        value = min(255, max(0, int(
            0.4 * circle_value + 
            0.5 * gradient_value + 
            0.1 * noise
        )))
        
        return value


if __name__ == "__main__":
    root = tk.Tk()
    app = ESMScanController(root)
    root.geometry("800x600")
    root.mainloop()