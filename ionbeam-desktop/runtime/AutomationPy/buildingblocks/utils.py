#-------------------------------------------------------------------------------
# This file contains 'Framework Code' and is licensed as such
# under the terms of your license agreement with  your
# vendor. This file may not be modified, except as allowed by
# additional terms of your license agreement.
#
## @file
# Auther: Henry Li
#

# This software and associated documentation (if any) is furnished
# under a license and may only be used or copied in accordance
# with the terms of the license. Except as permitted by such
# license, no part of this software or documentation may be
# reproduced, stored in a retrieval system, or transmitted in any
# form or by any means without the express written consent of

#-------------- -----------------------------------------------------------------
import sys, os
import random
import string
from enum import Enum
try:
    import Queue as queue
except:
    import queue as queue

DefaultRecurringInterval = 1
DefaultTimeStampFormat = "%Y-%m-%d %H:%M:%S"


class RESULTS(Enum):
    PASSED = 'PASSED'
    FAILED = 'FAILED'
    SKIPPED = 'SKIPPED'
    UNKNOWN = 'UNKNOWN'


class InvalidArgumentException(Exception):
    def __init__(self, arg):
        super(InvalidArgumentException, self).__init__()
        self.msg = '"{}" is an invalid parameter.'.format(str(arg))

    def __str__(self):
        return self.msg


class Position(list):
    def __init__(self,x=0, y=0, z=0):
        super(Position, self).__init__((x,y,z))

    x = property(lambda self: self[0],
                 lambda self,value: self.__setitem__(0, value))
    y = property(lambda self: self[1],
                 lambda self,value: self.__setitem__(1, value))
    z = property(lambda self: self[2],
                 lambda self,value: self.__setitem__(2, value))

def GetLocalHostIP():
    import socket, struct

    def _get_interface_ip(ifname):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        return socket.inet_ntoa(_fcntl.ioctl(s.fileno(), 0x8915, struct.pack('256s', ifname[:15]))[20:24])

    def _fcntl():
        return 0
    ip = socket.gethostbyname(socket.gethostname())
    if ip.startswith("127.") and os.name != "nt":
        interfaces = ["eth0","eth1","eth2","wlan0","wlan1","wifi0","ath0","ath1","ppp0",]
        for ifname in interfaces:
            try:
                ip = _get_interface_ip(ifname)
                break
            except IOError:
                pass
    return ip


def Int2HexString(intVal, with0xprefix=True):
    if with0xprefix:
        return '0x{:02X}'.format(intVal)
    return '{:02X}'.format(intVal)  # Fixed typo


def EscapedHexdecimalConverter(key):
    dic = {u'\\x0d':'\x0d',
           u'\\x1b': '\x1b',  #escape
           u'\\x0a':'\x0a',
           u'^[A': '\x1b[A',  #up arrow
           u'^[B': '\x1b[B',  #down arrow
           u'\\x20':'\x20',
           u'\\x7e':'\x7e',
           u'\\x40': '\x40',
           u'\\x1b2': '\x1b2',  #F2
           u'\\x1b0A': '\x1b0A',  #F10
           u'\\x1b\\x32':'\x1b\x32',
           u'\\x1b\\x01\\x00':'\x1b\x01\x00',
           u'\\x4E':'\x4E',
           u'\\x59':'\x59'}
    return dic.get(key, None)  # Optimized using get method

def IdGenerator(size = 32, chars=string.ascii_uppercase + string.digits):
    return ''.join(random.choice(chars) for _ in range(size))

def Hex2BinConverter(hexString, delimiter = ''):
    if hexString is None or not len(hexString) > 0:
        return None
    if hexString.endswith('b') or hexString.endswith('B'):
        return hexString.replace('b', '').replace('B', '')
    hex2bin_map = {
        "0": "0000",
        "1": "0001",
        "2": "0010",
        "3": "0011",
        "4": "0100",
        "5": "0101",
        "6": "0110",
        "7": "0111",
        "8": "1000",
        "9": "1001",
        "a": "1010",
        "b": "1011",
        "c": "1100",
        "d": "1101",
        "e": "1110",
        "f": "1111",
    }
    return delimiter.join(hex2bin_map[i] for i in hexString.lower())

def GetSitePackagePath():
    try:
        return os.path.join(sys.executable.replace('python.exe', ''), 'lib\\site-packages')
    except Exception:
        return None

def FindUnInstalledPackages(checklist):
    uninstalledPackages = checklist
    sitepackagepath = os.path.join(sys.executable.replace('python.exe', ''), 'lib\\site-packages')
    if sitepackagepath is not None:
        dirs = os.listdir(GetSitePackagePath())
        uninstalledPackages = [x for x in checklist if x not in dirs]
    return uninstalledPackages



def CreateInstance(classname, *args, **kwargs):
    namespaces = ['workstates']
    namespaces.append(classname)
    q = queue.Queue()
    instance = None
    try:
        m = ''
        for x in namespaces:
            m += '{0}.'.format(x)
            q.put(x)

        m = m.rstrip('.')
        module = __import__(m)
        q.get_nowait()
        instance = getattr(_extractAttr(module, q), classname)(*args, **kwargs)
    except Exception as e:
        print('Exception caught at CreateInstance, error was :%s' % str(e))
    return instance


def _extractAttr(module, q):
    if q is None or not q.qsize() > 0:
        return module
    n = q.get_nowait()
    m = getattr(module, n)
    return _extractAttr(m, q)

class Bcolors(Enum):
    def __str__(self):
        return self.value

    RED = "\033[1;31m"
    BLUE = "\033[1;34m"
    CYAN = "\033[1;36m"
    GREEN = "\033[0;32m"
    RESET = "\033[0;0m"
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'
def PrintMessage(msg, color):
    if not(msg is None or len(msg) == 0):
        sys.stdout.write(color.value)
        print(msg)
        sys.stdout.write(Bcolors.RESET.value)

def GetStateConfigByName(config, stateName):
    if config is not None and stateName is not None:
        for action in config.Actions:
            if stateName in action:
                return action[stateName]
    return None