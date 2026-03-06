from workthreads.dataIOThread import dataIOThread

class readDataThread(dataIOThread):
    def __init__(self, config, deviceId=None):
        super(readDataThread, self).__init__(config, deviceId)

