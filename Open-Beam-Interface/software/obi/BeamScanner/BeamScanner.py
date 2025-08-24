import numpy as np

class BeamScanner(object):
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