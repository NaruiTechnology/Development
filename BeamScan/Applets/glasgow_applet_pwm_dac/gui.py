import tkinter as tk
from glasgow.hardware.device import GlasgowDevice



def run_gui():
    device = GlasgowDevice().open()
    device.allocate_interface()
    device.run()

    root = tk.Tk()
    root.title("PWM DAC Control")

    value = tk.IntVar(value=128)
    resolution = tk.IntVar(value=8)

    def update_value(val):
        device.write_register(0x00, int(val))

    def update_resolution(val):
        device.write_register(0x01, int(val))

    tk.Label(root, text="PWM Value (0–255):").pack()
    tk.Scale(root, from_=0, to=255, orient="horizontal", variable=value, command=update_value).pack()

    tk.Label(root, text="Resolution (1–8 bits):").pack()
    tk.Scale(root, from_=1, to=8, orient="horizontal", variable=resolution, command=update_resolution).pack()

    update_value(128)
    update_resolution(8)
    root.mainloop()

if __name__ == "__main__":
    run_gui()
