# -------------------------------------------------------------------------------
# Name:        InvokeFactory
# Purpose:      To provide a singleton to access BMC or Aardvark
#
# Author:      henry.li@intel.com
#
# Created:     28/10/2017
# Copyright:   (c) liyingho 2017
# Licence:     <your licence>
# -------------------------------------------------------------------------------
import os,json
from .invokePyipmiTool import InvokePyipmiTool
from .invokeAadvark import InvokeAadvark
from .invokeITP import InvokeITP
import threading

class InvokeFactory:
    def __init__(self, log, defaultDevice='ITP',configJson=None):
        self._log = log
        self._deviceDictionary = {}
        self._lock = threading.Lock()
        self._selected = None

        if configJson is None:
            jsonpath = os.path.abspath(
                os.path.dirname(__file__).replace('buildingblocks', '') + r'workthreads/Json/Device.json')
            configjson = open(jsonpath).read()
        else:
            configjson = configJson

        config = json.loads(configjson)
        if not defaultDevice is None:
            config['default'] = defaultDevice

        self.Setup(log, config)

    def Setup(self, log, config):
        try:
            if self._lock.acquire(False):
                self._deviceDictionary.clear()
                bridge = int(config['bridge'], 0)
                target = int(config['target'], 0)
                for device in config['devices']:
                    if not device in self._deviceDictionary.keys():
                        invoke = None
                        devicename = device['name'].lstrip().lower()
                        defaultdevice = config['default'].lstrip().lower()
                        if devicename == 'bmc':
                            invoke = InvokePyipmiTool(device["ipaddress"],
                                                      device["username"],
                                                      device["password"],
                                                      bridge,
                                                      target,
                                                      int(device['port'], 0),
                                                      'ipmitool',
                                                      device['protocol'])
                        elif devicename == 'aardvark':
                            invoke = InvokeAadvark()
                        elif devicename == 'itp':
                            invoke = InvokeITP(log)
                        self._deviceDictionary[devicename] = invoke
                        if devicename == defaultdevice:
                            self._selected = invoke
        except Exception as e:
            print(str(e))
        finally:
            self._lock.release()

    def Get(self, device):
        devicename = device.lstrip().lower()
        if devicename in self._deviceDictionary.keys():
            return self._deviceDictionary[devicename]
        return None

    def DefaultDevice(self):
        return self._selected