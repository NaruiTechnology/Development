#-------------------------------------------------------------------------------
# Name:        module1
# Purpose:
#
# Author:      liyingho
#
# Created:     07/13/2019
# Copyright:   (c) liyingho 2017
# Licence:     <your licence>
#-------------------------------------------------------------------------------
import sys, os, json
sys.path.append(os.path.split(os.path.dirname(os.getcwd()))[0])
import pyipmi
import pyipmi.interfaces
from pyipmi import Target
import binascii
import utils as util
from threading import Lock
'''
    This class has bas been implemented using the Singleton designs pattern
'''
class InvokeAadvark(object):
    _instanceAardvark = None
    def __new__(cls, *args, **kwargs):
        if not cls._instanceAardvark:
            cls._instanceAardvark = super(InvokeAadvark, cls).__new__(cls, *args, **kwargs)
            try:
                jsonpath = os.path.abspath(
                    os.path.dirname(__file__).replace('buildingblocks', '') + r'workthreads/Json/Device.json')
                config = json.loads(open(jsonpath).read())
                slave = int(config['devices'][0]['slaveaddress'], 16)
                port = int(config['devices'][0]['port'], 16)
                bridge = int(config['bridge'], 16)  # 0x06
                target = int(config['target'], 16)  # 0x2c
                interface = pyipmi.interfaces.create_interface('aardvark', slave, port, None)

                cls._instanceAardvark._target = Target(target)
                connection = pyipmi.create_connection(interface)
                connection.target = cls._instanceAardvark._target
                connection.target.set_routing([(0, bridge)])
                connection.session.establish()
                cls._instanceAardvark._connection = connection
                cls._instanceAardvark._interface = interface
                cls._instanceAardvark._rc = 0
                cls._aadVarkMutex = Lock()
            except Exception as e:
                print(str(e))
        return cls._instanceAardvark

    @classmethod
    def InvokeIpmiTool(cls, params):
        with cls._aadVarkMutex:
            output = cls._instanceAardvark.InvokeIpmiRaw('', params.replace('raw ', ''), '')
        return output

    @classmethod
    def InvokeIpmiRaw(cls, manuID, command, params, outFile = None):
        with cls._aadVarkMutex:
            if cls._instanceAardvark._connection is None:
                return None
            split = command.split(' ')

            rawbytes = util.FormatRawbytes(manuID, split, params)
            raw = cls._instanceAardvark._connection.session._interface.send_and_receive_raw(cls._instanceAardvark._target, 0, int(split[0], 16), rawbytes)
            data, rc = cls._instanceAardvark._parseRawResults(raw)

            cls._instanceAardvark._rc = rc
            if outFile is not None:
                outFile.write(data)
                outFile.flush()
        return data

    @classmethod
    def _parseRawResults(cls, raw):
        rc = 0xff
        if raw is None:
            return None
        results = ''
        hexString = binascii.hexlify(raw)
        rc = int(hexString[0:2], 16)
        results = ''
        lDx = 2
        hDx = 3
        while hDx < len(hexString):
            results = results + "{0}{1} ".format(hexString[lDx], hexString[hDx])
            lDx += 2
            hDx += 2

        return [results, rc]


if __name__ == '__main__':
    invokeAadvark = InvokeAadvark()#0x20, 0x06, 0x2c, 0)#, 2238348106)
    '''
    invokeAadvark2 = InvokeAadvark(0x20, 0x06, 0x2c, 0)
    if id(invokeAadvark) == id(invokeAadvark2):
        print('Same')
    else:
        print('Different')
    '''
    try:
        data = invokeAadvark.InvokeIpmiRaw('0x57 0x01 0x00', '0x2e 0xC8', '0x01 0x00 0x01')
        data = invokeAadvark.InvokeIpmiRaw(None, '0x06 0x04', None)
    except Exception as e:
        print(str(e))
    pass
