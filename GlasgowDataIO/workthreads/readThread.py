import AutomationPy.buildingblocks.utils as util
from workthreads.dataIOThread import dataIOThread

class readDataThread(dataIOThread):
    def __init__(self, config, deviceId=None, data=None):
        super(readDataThread, self).__init__(config, deviceId, data)

