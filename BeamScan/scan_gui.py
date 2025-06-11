
# Requiremets to generate an electronic beam pattern scan for an electron microscope.  The requirements are listed below: 
# 1. The Glasgow Interface Explore revC2 and its supported library/applets must be used.
# 2. The applets and libraries of the Amaranth language are essential to this component
# 3. Python must be used
# 4. To use a Python class as the outlet is preferred.  The class should be implemented using the Singleton design pattern.
# 5.  The data members of the scanning pattern-generating class must include:
#      a) An array of data structure values.  The members of the data structure include: Electronic Volts, Z     axis value in float type,  a tuple of the eV value pairs (mapped to the 2-D x-y axis coordinate pairs i of the target sample area in the float type).
#      b) The reflection values are read back in float type.
# 6) Three callable functions are required: StarScan, PauseScan, StopScan. An event will be signaled when each function is called. 

# Install Glasgow Haskell Compiler
# https://www.google.com/search?q=how+to+compile+and+run+Glasgow+on+windows+10&rlz=1C1UEAD_enUS1140US1140&oq=how+to+compile+and+run+Glasgow+on+windows+10&gs_lcrp=EgZjaHJvbWUyBggAEEUYOTIHCAEQIRigATIHCAIQIRigATIHCAMQIRigAdIBCTM0NzAyajBqN6gCALACAA&sourceid=chrome&ie=UTF-8
# pip install matplotlib
import tkinter as tk
from tkinter import ttk, filedialog
from beam_scan_controller import BeamScanController, ScanPoint
from GUI.scan_pattern_generator import * # generate_raster_pattern
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import threading
import time
import csv

class ScanGUI:
    def __init__(self, root):
        self.root = root
        # Add this to the top of your ScanGUI class in __init__ (after self.root = root):
        # Scan Settings
        settings_frame = ttk.LabelFrame(root, text="Scan Settings")
        settings_frame.pack(padx=10, pady=10, fill="x")

        self.ev_var = tk.DoubleVar(value=1.5)
        self.z_var = tk.DoubleVar(value=0.1)
        self.x_min_var = tk.DoubleVar(value=0.0)
        self.x_max_var = tk.DoubleVar(value=0.5)
        self.y_min_var = tk.DoubleVar(value=0.0)
        self.y_max_var = tk.DoubleVar(value=0.5)
        self.step_var = tk.DoubleVar(value=0.1)

        entries = [
            ("eV", self.ev_var),
            ("Z", self.z_var),
            ("X min", self.x_min_var),
            ("X max", self.x_max_var),
            ("Y min", self.y_min_var),
            ("Y max", self.y_max_var),
            ("Step", self.step_var),
        ]

        for i, (label, var) in enumerate(entries):
            ttk.Label(settings_frame, text=label).grid(row=i // 4, column=(i % 4) * 2, sticky="e", padx=5, pady=2)
            ttk.Entry(settings_frame, textvariable=var, width=6).grid(row=i // 4, column=(i % 4) * 2 + 1, padx=5)


        self.controller = BeamScanController()

        root.title("Electron Beam Scan Controller")
        root.geometry("700x500")

        # Buttons
        btn_frame = ttk.Frame(root)
        btn_frame.pack(pady=10)

        self.start_button = ttk.Button(btn_frame, text="Start Scan", command=self.start_scan)
        self.start_button.grid(row=0, column=0, padx=5)
        # self.start_button.pack(side=tk.LEFT, padx=5)

        self.pause_button = ttk.Button(btn_frame, text="Pause Scan", command=self.pause_scan)
        self.pause_button.grid(row=0, column=1, padx=5)

        self.stop_button = ttk.Button(btn_frame, text="Stop Scan", command=self.stop_scan)
        self.stop_button.grid(row=0, column=2, padx=5)

        self.export_button = ttk.Button(btn_frame, text="Export CSV", command=self.export_csv)
        self.export_button.grid(row=0, column=3, padx=5)

        self.status = tk.StringVar()
        self.status.set("Ready")
        self.status_label = ttk.Label(root, textvariable=self.status)
        self.status_label.pack()

        # Matplotlib figure
        self.fig, self.ax = plt.subplots(figsize=(6, 3))
        self.ax.set_title("Reflection Values")
        self.ax.set_xlabel("Point Index")
        self.ax.set_ylabel("Reflection")
        self.line, = self.ax.plot([], [], 'b.-')

        self.canvas = FigureCanvasTkAgg(self.fig, master=root)
        self.canvas_widget = self.canvas.get_tk_widget()
        self.canvas_widget.pack(pady=10)

        self.running = False

        # Add Heatmap Axes to GUI
        # Matplotlib figure with two plots: line + heatmap
        self.fig, (self.ax_line, self.ax_heatmap) = plt.subplots(2, 1, figsize=(6, 5))

        # Line plot
        self.ax_line.set_title("Reflection vs. Point Index")
        self.ax_line.set_xlabel("Point Index")
        self.ax_line.set_ylabel("Reflection")
        self.line, = self.ax_line.plot([], [], 'b.-')

        # Heatmap plot
        self.heatmap_data = None
        self.heatmap = self.ax_heatmap.imshow([[0]], cmap="inferno", origin="lower", interpolation="nearest")
        self.ax_heatmap.set_title("Reflection Heatmap")
        self.ax_heatmap.set_xlabel("X")
        self.ax_heatmap.set_ylabel("Y")

        self.canvas = FigureCanvasTkAgg(self.fig, master=root)
        self.canvas_widget = self.canvas.get_tk_widget()
        self.canvas_widget.pack(pady=10)

    def start_scan(self):
        # self.controller.scan_data = generate_raster_pattern(
        #     x_range=(0.0, 0.5),
        #     y_range=(0.0, 0.5),
        #     step=0.1,
        #     eV=1.5,
        #     z_value=0.1
        # )
        x_range = (self.x_min_var.get(), self.x_max_var.get())
        y_range = (self.y_min_var.get(), self.y_max_var.get())
        step = self.step_var.get()
        eV = self.ev_var.get()
        z = self.z_var.get()

        self.controller.scan_data = generate_raster_pattern(
            x_range=x_range,
            y_range=y_range,
            step=step,
            eV=eV,
            z_value=z
        )
        self.status.set("Scan running...")
        self.running = True
        self.controller.start_scan()
        threading.Thread(target=self.update_plot, daemon=True).start()

    def pause_scan(self):
        self.status.set("Paused")
        self.controller.pause_scan()

    def stop_scan(self):
        self.status.set("Stopped")
        self.running = False
        self.controller.stop_scan()

    def update_plot(self):
        while self.running and not self.controller._stop_event.is_set():
            data = self.controller.scan_data
            reflections = [p.reflection_value for p in data if p.reflection_value > 0]
            self.line.set_data(range(len(reflections)), reflections)
            self.ax_line.relim()
            self.ax_line.autoscale_view()

            # Build 2D heatmap grid
            if reflections:
                # Normalize grid
                xs = sorted(set(p.xy_position[0] for p in data))
                ys = sorted(set(p.xy_position[1] for p in data))
                x_index = {v: i for i, v in enumerate(xs)}
                y_index = {v: i for i, v in enumerate(ys)}
                grid = [[0.0 for _ in xs] for _ in ys]
                for p in data:
                    if p.reflection_value > 0:
                        xi = x_index[p.xy_position[0]]
                        yi = y_index[p.xy_position[1]]
                        grid[yi][xi] = p.reflection_value

                self.heatmap.set_data(grid)
                self.ax_heatmap.set_xticks(range(len(xs)))
                self.ax_heatmap.set_xticklabels([round(x, 2) for x in xs])
                self.ax_heatmap.set_yticks(range(len(ys)))
                self.ax_heatmap.set_yticklabels([round(y, 2) for y in ys])
                self.heatmap.set_clim(vmin=min(reflections), vmax=max(reflections))

            self.canvas.draw()
            time.sleep(0.5)

    def export_csv(self):
        if not self.controller.scan_data:
            return
        filename = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV files", "*.csv")])
        if not filename:
            return
        with open(filename, "w", newline='') as f:
            writer = csv.writer(f)
            writer.writerow(["eV", "Z", "X", "Y", "Reflection"])
            for p in self.controller.scan_data:
                x, y = p.xy_position
                writer.writerow([p.electron_volts, p.z_value, x, y, p.reflection_value])
        self.status.set(f"Exported to {filename}")

if __name__ == "__main__":
    root = tk.Tk()
    root.configure(bg="dimgray")
    app = ScanGUI(root)
    root.mainloop()
