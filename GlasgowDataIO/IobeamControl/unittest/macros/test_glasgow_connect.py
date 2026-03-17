
import unittest
import asyncio
from pathlib import Path
from IobeamControl.transfer.glasgowStream import GlasgowConnection
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from IobeamControl.transfer.mock import MockConnection
from IobeamControl.commands.structs import struct
from GlasgowDataIO.workstates.streamData_state import streamData_state

JSON_PATH = r'./Development/GlasgowDataIO/Json/directIo.json'
TASK_NAME = r'patternScan'
STREAM_DATA_FILE = r'./Development/GlasgowDataIO/Data/large_waveform.csv'

class GlasgowConnectTest(unittest.TestCase):
    def setUp(self):
        self.sim_data = "0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10, 0.0, 1, 2, 5, 8, 9, 10"     
        if Path(JSON_PATH).is_file():
            self._config = AutomationConfig(JSON_PATH)
        else:
            self._config = None

    def test_connect(self):
        asyncio.run(self.connect_test())
    def test_mock_connection(self):
        asyncio.run(self.run_mock_stream_test())
    def test_simulation_data(self):
        asyncio.run(self.run_sim_data_test())
    def test_large_file_stream(self):
        asyncio.run(self.run_large_file_stream_test())
    def test_mock_connection(self):
        asyncio.run(self.run_mock_stream_test())
    def test_simulation_data(self):
        asyncio.run(self.run_sim_data_test())
    def test_large_file_stream(self):
        asyncio.run(self.run_large_file_stream_test())        

    async def connect_test(self):
        if self._config is not None:
            conn = GlasgowConnection(self._config, TASK_NAME)
            await conn._connect()
            pass

    async def run_mock_stream_test(self):
        """Test 1: Uses MockConnection to verify data flow without hardware."""
        conn = MockConnection()
        await conn._connect()
        
        # Simulating the packing logic for a 12-bit resolution
        test_values = [0, 1, 2, 5, 8, 9, 10]
        packed_data = struct.pack(f">{len(test_values)}H", *test_values)
        
        await conn.transfer_bytes(packed_data)
        self.assertTrue(conn.connected)
        print("Mock stream test completed successfully.")        

    async def run_sim_data_test(self):
        if self._config is not None:
            # Initialize state with 'custom' waveform to use raw sim data
            state = streamData_state(MockThread(), waveForm='custom', data=self.sim_data)
            await state.DoWork()
            self.assertTrue(state._success)
            print("Simulation data stream test completed.")        

    async def run_large_file_stream_test(self):
            """Test 3: Opens a data stream file with a large amount of data."""
            if Path(STREAM_DATA_FILE).is_file() and self._config is not None:
                with open(STREAM_DATA_FILE, 'r') as f:
                    large_data = f.read()
                
                state = streamData_state(MockThread(), waveForm='custom', data=large_data)
                await state.DoWork()
                self.assertTrue(state._success)
                print(f"Large file stream test ({len(large_data)} chars) completed.")
            else:
                self.skipTest("Large data file or JSON config not found.")    

class MockThread:
    def __init__(self, config):
        self.Config = config
        self.TaskName = TASK_NAME

    def GetStateConfig(self, state):
        return self._config.Actions[0].get(TASK_NAME)  

