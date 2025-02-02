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
import serial
import serial.tools.list_ports as listport
from threading import Lock
import buildingblocks.utils as util


'''
    This class has bas been implemented using the Singleton designs pattern
'''


class InvokeSerial(object):
    _instanceInvokeSerial = None
    def __new__(cls, *args, **kwargs):
        if not cls._instanceInvokeSerial:
            cls._instanceInvokeSerial = super(InvokeSerial, cls).__new__(cls)
            try:
                cls._invokeSerialMutex = Lock()
                port = args[0]
                portlist = listport.comports()
                if len(portlist) > 0:
                    if portlist[0].device != args[0]:
                        port = portlist[0].device
                cls._serial = serial.Serial(port, args[1])
            except Exception as e:
                print(str(e))
                raise Exception('Failed to initialize serial.\n')
        return cls._instanceInvokeSerial

    @classmethod
    def WriteRaw(cls, data):
        with cls._invokeSerialMutex:
            cls._serial.write(data)

    def WriteLinesRaw(cls, line):
        with cls._invokeSerialMutex:
            cls._serial.writelines(bytes(line))
    @classmethod
    def Write(cls, data):
        from time import sleep
        if cls._serial is not None:
            with cls._invokeSerialMutex:
                try:
                    d = util.EscapedHexdecimalConverter(data)
                    if d is not None:
                        cls._serial.write(d)
                        cls._serial.flush()
                        sleep(1)
                except Exception as e:
                    print(str(e))

    def WriteLines(cls, line):
        from time import sleep
        if cls._serial is not None:
            with cls._invokeSerialMutex:
                try:
                    cls._serial.writelines(bytes(util.EscapedHexdecimalConverter(line)))
                    cls._serial.flush()
                    sleep(1)
                except Exception as e:
                    print(str(e))
        pass

    @classmethod
    def ReadMessage(cls):
        if cls._serial is not None:
            with cls._invokeSerialMutex:
                try:
                    return cls._serial.read(cls._serial.inWaiting()).strip().lstrip()
                except Exception as e:
                    print(str(e))

    @classmethod
    def Flush(cls):
        if cls._serial is not None:
            with cls._invokeSerialMutex:
                try:
                    cls._serial.flush()
                except Exception as e:
                    print(str(e))

    @classmethod
    def FlushInput(cls):
        if cls._serial is not None:
            with cls._invokeSerialMutex:
                try:
                    cls._serial.flushInput()
                except Exception as e:
                    print(str(e))

    @classmethod
    def FlushOutput(cls):
        if cls._serial is not None:
            with cls._invokeSerialMutex:
                try:
                    cls._serial.flushOutput()
                except Exception as e:
                    print(str(e))
    @classmethod
    def Close(cls):
        if cls._serial is not None:
            with cls._invokeSerialMutex:
                try:
                    cls._serial.close()
                except Exception as e:
                    print(str(e))


if __name__ == '__main__':
    from time import sleep
    import array
    import re,sys

    ser = serial.Serial('COM3', 115200, timeout=5)
    ser.writelines(bytes('fs0:\r'))
    ser.writelines(bytes('ls\r'))
    sleep(2)
    ser.flushInput()
    ser.flushOutput()
    out = ''
    if ser.writable():
        #ser.writelines(bytes('^[OB')) # ('^[OQ')
        ser.write('\x1b[B')
        ser.flush()
        pass
'''
        ser.writelines(bytes(b'^[2')) # ESC 2 = F2 key
        ser.flush()
        ser.write('\x1b')# Escape ('^[OQ')
        ser.flush()
        ser.write('\x0d') # catrige return
        ser.flush()
        ser.write('\x1b\x32')  # F2
        ser.flush()
        ser.write('^[OQ')
        ser.flush()
        ser.write(r'\x1bOQ')
        ser.flush()
        ser.write('^[OM')
        ser.flush()
        ser.write(r'\x1bOM')
        ser.flush()
        #while ser.inWaiting() > 0:
        out = ser.readline()
        print out
    ser.close()



    invokeSerial = InvokeSerial('COM3', 115200)
    f = open('test.log', 'w')
    while True:
        buffer = invokeSerial.ReadMessage().strip()
        if buffer != '':
            #invokeSerial._logInfo(buffer)
            f.writelines(buffer)
            f.flush()
            print(buffer)
            if len(re.findall('Press F2', buffer.replace('[', '').replace(']', ''))) > 0:
                #invokeSerial._logInfo("--- boot completed ----")
                f.writelines('---- boot complete ----')
                f.flush()

                print('---- boot complete ----')
                invokeSerial.FlushInput()
                sleep(1)
                break
    invokeSerial.Write('^[2')#'(r'\x1bOQ')#(r'\x3B')#r'\x1b0Q') #send F2 key
    invokeSerial.Flush()
    #invokeSerial.Write(r'\x1bOM')
    #invokeSerial.Flush()
    sleep(1)
    while True:
        buffer = invokeSerial.ReadMessage().strip()
        if buffer != '':
            #invokeSerial._logInfo(buffer)
            f.writelines(buffer)
            f.flush()
            print(buffer)
            
            
            

if __name__ == '__main__':
    import re
    from time import sleep

    invokeSerial = None
    try:
        invokeSerial = InvokeSerial('COM3', 115200)
        slice(2)
        invokeSerial.Flush()
        f = open('test.log', 'w')
        while True:
            buffer = invokeSerial.ReadMessage().strip()
            if buffer != '':
                f.writelines(buffer)
                f.flush()
                print(buffer)
                if len(re.findall('Press F2', buffer.replace('[', '').replace(']', ''))) > 0:
                    print('---- boot complete ----')
                    break
        invokeSerial.Write('\x1b\x32')#send F2 key - ESC 2
        #invokeSerial.WriteLines(b'^[2')  # send F2 key
        sleep(2)
        invokeSerial.Write('\x0d')#send catrige return to enter EDII menu
        sleep(0.5)
        invokeSerial.WriteLines(b'^[OB') #^[OB - arrow down, ^[OA - arrow up
        sleep(0.5)
        invokeSerial.WriteLines(b'^[OB') #^[OB - arrow down, ^[OA - arrow up
        sleep(0.5)
        invokeSerial.Write('\x1b')# ESC
        sleep(0.5)
    except Exception as e:
        print(str(e))
    finally:
        if invokeSerial is not None:
            invokeSerial.Close()

'''