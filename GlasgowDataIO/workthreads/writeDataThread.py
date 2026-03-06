from .dataIOThread import dataIOThread

class writeDataThread(dataIOThread):
    def __init__(self, config, deviceId=None, data=None):
        super(writeDataThread, self).__init__(config, deviceId, data)
        
        