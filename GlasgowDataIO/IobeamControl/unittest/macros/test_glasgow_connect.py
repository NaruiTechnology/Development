
import unittest
import asyncio
from pathlib import Path
from IobeamControl.transfer.glasgowStream import GlasgowConnection
from AutomationPy.buildingblocks.automation_config import AutomationConfig

JSON_PATH = r'./Development/GlasgowDataIO/Json/directIo.json'
TASK_NAME = r'patternScan'
class GlasgowConnectTest(unittest.TestCase):
    
    async def connect_test(self):
        if Path(JSON_PATH).is_file():
            config = AutomationConfig(JSON_PATH)
            conn = GlasgowConnection(config, TASK_NAME)
            await conn._connect()

    def test_connect(self):
        asyncio.run(self.connect_test())
