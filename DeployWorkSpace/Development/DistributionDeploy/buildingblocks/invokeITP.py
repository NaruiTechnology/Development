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
import sys, os, time
sys.path.append(os.path.split(os.path.dirname(os.getcwd()))[0])
import itpii
from threading import Lock


'''
    This class has bas been implemented using the Singleton designs pattern
'''


class InvokeITP(object):
    _instanceInvokeITP = None

    def __new__(cls, *args, **kwargs):
        if not cls._instanceInvokeITP:
            msg = ''
            cls._instanceInvokeITP = super(InvokeITP, cls).__new__(cls)
            cls._log = args[0]
            try:
                itp = itpii.baseaccess()
                if not itp is None and len(itp.devicelist) > 0:
                    cls._logInfo('Initial IPT success\n')
                    cls._itp = itp
                    cls._itpMutex = Lock()
                else:
                    raise Exception('Failed to initialize ITP.\n')
            except Exception as e:
                # print(str(e))
                cls._logInfo(str(e))

        return cls._instanceInvokeITP

    @classmethod
    def IsRunning(cls):
        return cls._itp.cv.isrunning

    @classmethod
    def Unlock(cls):
        try:
            cls._itp.unlock(0, "green")
        except Exception as e:
            cls._logInfo('Exception caught when call itp Unlock, error = {0}\n'.format(str(e)))

    @classmethod
    def Go(cls):
        try:
            with cls._itpMutex:
                cls._itp.go()
        except Exception as e:
            cls._logInfo('Exception caught when call itp Go, error = {0}\n'.format(str(e)))

    @classmethod
    def Halt(cls):
        try:
            with cls._itpMutex:
                cls._itp.halt()
        except Exception as e:
            cls._logInfo('Exception caught when call itp Halt, error = {0}\n'.format(str(e)))

    @classmethod
    def PulsePowerButton(cls):
        with cls._itpMutex:
            hook1_state = cls._itp.hookstatus(0,1)
            cls._logInfo("Hook1 State = %s" % hook1_state)
            if hook1_state is True:
                cls._itp.holdhook(0,1,0) # Release Hook
                time.sleep(1) # Sleep for 1 second
            cls._itp.holdhook(0,1,1) # Assert PowerButton
            time.sleep(1) # Sleep for 1 second
            cls._itp.holdhook(0,1,0) # De-assert PowerButton

    @classmethod
    def TurnSystemOnOrOff(cls, on = True):
        with cls._itpMutex:
            isSystemOn = cls._itp.cv.targpower
            cls._logInfo("isSystemOn = %s" % isSystemOn)

            hook1_state = cls._itp.hookstatus(0,1)
            cls._logInfo("Hook1 State = %s" % hook1_state)
            success = False
            if on:
                if isSystemOn:
                    print ("System is on, exiting without any actions")
                    return
                else:
                    if hook1_state is True:
                        cls._itp.holdhook(0,1,0) # Release Hook
                        time.sleep(1) # Sleep for 1 second

                    for i in range(0,2):
                        cls._itp.holdhook(0,1,1) # Assert PowerButton
                        time.sleep(0.25)
                        cls._itp.holdhook(0,1,0) # Release PowerButton
                        time.sleep(5)
                        isSystemOn = cls._itp.cv.targpower
                        if isSystemOn is True:
                            success = True
                            break;
                        cls._logInfo("Turn on the system success = {0}".format(success))
            else:
                cls._itp.holdhook(0,1,1) # Assert PowerButton
                time.sleep(1) # Sleep for 1 second to see if power turns off or is it going to have to power button overrride
                for i in range(0,2):
                    cls._logInfo("Power Button was pushed to turn off system and the system_on = {0}, retry = {1}".format(isSystemOn, i))
                    cls._logInfo("Waiting 5 seconds to check if power is still on")
                    time.sleep(5)
                    isSystemOn = cls._itp.cv.targpower
                    if isSystemOn == False:
                        success = True
                        break
                cls._logInfo("Turn off the system success = {0}".format(success))
                cls._itp.holdhook(0,1,0) # De-Assert PowerButton

    @classmethod
    def PulsePowerGoodAutoconfigOff(cls):
        """
        Turns off the autoconfig option in DAL to avoid node error on DAL
        """
        with cls._itpMutex:
            itplist = cls._itp.debugports
            for i in range(len(itplist)):
                cls._itp.autoconfig(i, 0)
            cls._itp.pulsepwrgood()
            for i in range(len(itplist)):
                cls._itp.autoconfig(i, 0x0004 | 0x0008)

    @classmethod
    def ResetBreak(cls, on = True):
        with cls._itpMutex:
            val = 1
            if not on:
                val = 0
            cls._logInfo('Reset break = '.format(val))
            cls._itp.cv.resetbreak = val

            results = True
            try:
                for thread in cls._itp.threads:
                    if on :
                        success = 0 ^ thread.cv.resetbreak
                    else :
                        success = 1 ^ thread.cv.resetbreak
                    cls._logInfo('Reset thread {0} to {1} {2}'.format(thread, val, success))
                    results = results and success
            except Exception as e:
                cls._logInfo('Exception caught when reset break, error = {0}\n'.format(str(e)))
        return results

    @classmethod
    def _logInfo(cls, message):
        with cls._itpMutex:
            return cls._log.info(message)


if __name__ == '__main__':
    from buildingblocks.AutomationLog import AutomationLog
    logName = 'InvokeITP'
    log = AutomationLog(logName)
    invokeITP = InvokeITP(log.GetLogger(logName))
    log.TryAddConsole(logName)
    invokeITP.IsRunning()
    invokeITP.Unlock()
    #invokeITP.TurnSystemOnOrOff(False)
    #invokeITP.TurnSystemOnOrOff(True)
    pass