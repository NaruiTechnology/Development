import asyncio
import math
from GlasgowDataIO.workstates.dataIO_state import dataIO_state
from AutomationPy.buildingblocks.definitions import Consts
from AutomationPy.buildingblocks.decorators import overrides
from GlasgowDataIO.IobeamControl.commands.structs import struct

class streamData_state(dataIO_state):
    def __init__(self, parent, waveForm=None, data=None):
        super(streamData_state, self).__init__(parent)
        self._waveForm = waveForm 
        self._data = data
        self._conn = None

    @property
    def Conn(self):
        return self._conn
    @Conn.setter
    def Conn(self, val):
        self._conn = val

    @overrides(dataIO_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            action = stateConfig.get(Consts.ACTION_DATA)
            
            # Configuration from JSON
            voltage = action.get('voltage', 3.3)
            commandFormat = action.get('commandFormat')
            frequency = action.get('frequency', 10)
            point_count = action.get('point', 100)
            if self._waveForm is None:
                self._waveForm = action.get('waveForm', 'sine')
                   
            resolution = 0
            pins_arg = ''
            pin_val_format = ''
            ports = action.get('ports')

            if isinstance(ports, list):
                for item in ports:
                    pList = item.get('pinList')
                    if pList:
                        port_name = item.get('port')
                        for pin_idx in pList:                            
                            pins_arg += f"{port_name}{pin_idx},"
                            pin_val_format += f"{port_name}{pin_idx}={{}} "
                            resolution += 1
            
            pins_arg = pins_arg.rstrip(',')
            pin_val_format = pin_val_format.strip()

            # --- WAVEFORM LOGIC AGAINST DATA ---
            if self._data and len(self._data) > 0:
                if self.ParentWorkThread._config.Verbose:
                    self.ParentWorkThread.Logger.info(f"Applying '{self._waveForm}' logic to custom data (Length: {len(self._data)})")
                source_values = [v.strip() for v in self._data.replace('\n', ',').split(',') if v.strip()]
            else:
                if self.ParentWorkThread._config.Verbose:
                    self.ParentWorkThread.Logger.info(f"No custom data. Generating '{self._waveForm}' sequence with {point_count} points.")
                #source_values = [i / point_count for i in range(point_count)]
                source_values = self._data

            # Calculate final DAC integers
            if self._waveForm  not in ['sine', 'square', 'triangle', 'custom']:
                raise ValueError(f'Invalid waveform [{self._waveForm}] detected.')
            
            stream_source = self._calculate_stream(source_values, resolution)
            if not stream_source:
                self.ParentWorkThread.Logger.error("No valid data points to stream.")
                self._success = False
                return
            
            if not self.ParentWorkThread._config.Simulate:
                if self._conn is not None and self._conn.connected:
                    # Small yield to ensure the event loop handles any pending connection tasks
                    await asyncio.sleep(0.05) 
                    
                    pack_type = 'B' if resolution <= 8 else 'H'
                    max_chunk_bytes = action.get('directStreamChunckSize', 8192)
                    
                    # Ensure we are packing exactly what the resolution requires
                    for i in range(0, len(stream_source), max_chunk_bytes):
                        chunk = stream_source[i : i + max_chunk_bytes]
                        packed_chunk = struct.pack(f">{len(chunk)}{pack_type}", *chunk)
                        
                        # Attempt the transfer
                        await self._conn.transfer_bytes(packed_chunk)
                        #await self._conn.transfer_raw(packed_chunk)
                        await asyncio.sleep(0.1) 
                    
                    self._success = True
            else:
                # --- CLI SIMULATION MODE ---
                delay = 1.0 / (frequency * len(stream_source)) if len(stream_source) > 0 else 0
                for val in stream_source:
                    bits = [int(b) for b in bin(val)[2:].zfill(resolution)[::-1]]
                    # Format the pin assignments: e.g. "A0=0 A1=1 A2=0..."
                    pin_assignments = pin_val_format.format(*bits)          
                    if commandFormat:
                        cmd = commandFormat.format(voltage, pins_arg, pin_assignments)
                        self._success = await self.commandAsyncio(cmd)
                        if not self._success: 
                            if self.ParentWorkThread._config.Verbose:
                                print('Call GPIO command failed.')
                            break        
                    if self.ParentWorkThread._config.Verbose:
                        print(f'DAC Output: Wave form = [{self._waveForm}], Value=[{val}], frequency = [{frequency} Hz], Delay=[{delay:.5f} s]')               
                    await asyncio.sleep(delay)

        except Exception as e:
            self.ParentWorkThread.Logger.error(f"Waveform Execution Error: {e}")
            self._success = False
      
   
    def _calculate_stream(self, source, resolution):
        """
        Maps source values to DAC integers using waveform math.
        """
        max_dac_val = (1 << resolution) - 1
        stream = []
        
        # 1. Ensure all elements in source are numbers (int or float)
        # This handles cases where data might be passed as strings from CLI
        cleaned_source = []
        for val in source:
            try:
                cleaned_source.append(float(val))
            except (ValueError, TypeError):
                self.ParentWorkThread.Logger.warning(f"Skipping non-numeric value in stream: {val}")

        if not cleaned_source:
            self.ParentWorkThread.Logger.error("Stream data contains no valid numbers.")
            return []

        # 2. Safely calculate max_in for normalization
        max_in = max(cleaned_source)
        
        for v in cleaned_source:
            # Normalize to 0.0-1.0 if the input range is large 
            # and we are applying waveform math (sine/square/triangle)
            if self._waveForm != 'custom' and max_in > 1.0:
                t = v / max_in
            else:
                t = v
            
            if self._waveForm == "sine":
                raw = (math.sin(2 * math.pi * t) + 1) * (max_dac_val / 2)
            elif self._waveForm == "square":
                raw = max_dac_val if t < 0.5 else 0
            elif self._waveForm == "triangle":
                raw = max_dac_val * (1 - abs(2 * t - 1))
            else:
                # 'custom' logic: If input is 0..1, scale to DAC. 
                # If input is already > 1, treat as direct DAC counts.
                raw = v * max_dac_val if v <= 1.0 else v
            
            # Round and clamp to resolution limits
            final_val = int(round(raw))
            stream.append(max(0, min(final_val, max_dac_val)))
            
        return stream
    