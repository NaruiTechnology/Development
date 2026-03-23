
import unittest
import asyncio
from pathlib import Path
from IobeamControl.transfer.glasgowStream import GlasgowConnection
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from IobeamControl.transfer.mock import MockConnection
from IobeamControl.commands.structs import struct
from GlasgowDataIO.workstates.streamData_state import streamData_state
from GlasgowDataIO.workthreads.dataIOThread import dataIOThread
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from IobeamControl.transfer.glasgowStream import GlasgowConnection

JSON_PATH = r'./Development/GlasgowDataIO/Json/directIo.json'

STREAM_DATA_FILE = r'./Development/GlasgowDataIO/IobeamControl/unittest/testData/WaveformData_sine.csv'

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
    def test_transfer_data(self):
         if self._config is not None:
            conn = GlasgowConnection(self._config)
            asyncio.run(self._connect(conn))
            asyncio.run(self._transferData(conn))
            print("Transfer stream test completed successfully.") 

    def test_large_file_stream(self):
        asyncio.run(self.run_large_file_stream_test())
    

    async def connect_test(self):
        if self._config is not None:
            conn = GlasgowConnection(self._config)
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
            conn = MockConnection()
            await conn._connect()
            # Initialize state with 'custom' waveform to use raw sim data
            state = streamData_state(MockThread(self._config), waveForm='custom', data=self.sim_data)
            state.Conn = conn
            await state.DoWork()
            self.assertTrue(state._success)
            print("Simulation data stream test completed.")     
   

    async def _connect(self, conn):
        await conn._connect()    
    async def _transferData(self, conn):
        if conn.connected:
            state = streamData_state(MockThread(self._config), waveForm='square', data=self.sim_data)
            state._isSimulation = False
            state.Conn = conn
            await state.DoWork()
            self.assertTrue(state._success)              

    async def run_large_file_stream_test(self):
            """Test 3: Opens a data stream file with a large amount of data."""
            if Path(STREAM_DATA_FILE).is_file() and self._config is not None:
                with open(STREAM_DATA_FILE, 'r') as f:
                    large_data = f.read()

                conn = MockConnection()
                await conn._connect()
                
                state = streamData_state(MockThread(self._config), waveForm='custom', data=large_data)
                state.Conn = conn

                await state.DoWork()
                self.assertTrue(state._success)
                print(f"Large file stream test ({len(large_data)} chars) completed.")
            else:
                self.skipTest("Large data file or JSON config not found.")    

class MockThread(dataIOThread):
    def __init__(self, config):
        super(MockThread, self).__init__(config)

    @overrides(dataIOThread)
    def GetStateConfig(self, state):
        return self._config.Actions[0].get(Consts.STREAM_DATA)  

