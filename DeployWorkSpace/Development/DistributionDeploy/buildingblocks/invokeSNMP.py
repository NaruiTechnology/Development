from pysnmp import *
from threading import Lock
'''
    This class has bas been implemented using the Singleton designs pattern
'''
class InvokeSNMP(object):
    _instanceInvokeSNMP = None
    def __new__(cls, *args, **kwargs):
        if not cls._instanceInvokeSNMP:
            cls._instanceInvokeSerial = super(InvokeSNMP, cls).__new__(cls)
            try:
                cls._invokeSNMPMutex = Lock()
            except Exception as e:
                print(str(e))
                raise Exception('Failed to initialize SNMP.\n')
        return cls._instanceInvokeSNMP
    pass

if __name__ == '__main__':
    pass