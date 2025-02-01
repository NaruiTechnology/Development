#-------------------------------------------------------------------------------
# This file contains 'Framework Code' and is licensed as such
# under the terms of your license agreement with  your
# vendor. This file may not be modified, except as allowed by
# additional terms of your license agreement.
#
## @file
#

# This software and associated documentation (if any) is furnished
# under a license and may only be used or copied in accordance
# with the terms of the license. Except as permitted by such
# license, no part of this software or documentation may be
# reproduced, stored in a retrieval system, or transmitted in any
# form or by any means without the express written consent of

#-------------- -----------------------------------------------------------------
from abc import abstractmethod
from threading import Thread
from time import sleep
import os as os
import sys
import time
import buildingblocks.utils as util
from buildingblocks.event_handler import EventHandler
from buildingblocks.definitions import Consts


class WorkThreadMetaClass(type):
    def __new__(cls, name, parents, dct):
        if 'class_id' not in dct:
            dct['class_id'] = name.lower()
        return super(WorkThreadMetaClass, cls).__new__(cls, name, parents, dct)

    def __get__(self, obj, objtype):
        """Support instance methods."""
        import functools
        return functools.partial(self.__call__, obj)


class WorkThread:#abstract base class
    __metaclass__ = WorkThreadMetaClass
    file = __file__

    def __init__(self):
        self._thread = None#Thread(target = self.WorkerProcess, args = [None])
        self._isRunning = False
        self._recurringInterval = util.DefaultRecurringInterval
        '''
            NOTE: if the timeout value < 0, the life time for a work thread is infinit
        '''
        self._timeout = -1
        self._shutdownEvent = None
        self._id = repr("WorkThread_" + util.IdGenerator())
        
    @property
    def Id(self):
        return self._id
    
    @property
    def ShutdownEvent(self):
        return self._shutdownEvent

    @ShutdownEvent.setter
    def ShutdownEvent(self, val):
        self._shutdownEvent = val

    @property
    def RecurringInterval(self):
        return self._recurringInterval

    @RecurringInterval.setter
    def RecurringInterval(self, val):
        self._recurringInterval = val

    @property
    def Timeout(self):
        return self._timeout

    @Timeout.setter
    def Timeout(self, val):
        self._timeout = val

    @abstractmethod
    def IntialWork(self):
        raise NotImplementedError("user must implemente the IntialWork.")

    @abstractmethod
    def StateFactory(self, workState = None):
        raise NotImplementedError("user must implement the StateFatory.")

    def Setup(self, config):
        try:
            if config is not None:
                s = config.get("timeout", None)
                if s is not None and s.strip() != '':
                    self.SetTimeout(int(s))
                clsname = [type(self).__name__.replace('thread', '')]
                log_config = config.get("log", {})
                if clsname in log_config.keys():
                    logfileName = log_config[clsname]
                    if logfileName is not None and logfileName.strip() != '':
                        logpath = log_config.get("path", "current")
                        if logpath != "current":
                            logfileName = os.path.join(logpath, logfileName)
                        self.SetLogFileName(logfileName)
                recurring = config.get("recurring", '').strip()
                if recurring != '':
                    self._recurringInterval = int(recurring, 16)
        except:
            pass

    def Start(self):
        try:
            self._thread = Thread(target = self.WorkerProcess)
            if self._thread is not None:
                self._isRunning = True
                self._thread.start()
                #self._thread.join()
        except:
            type_, value_, traceback_ = sys.exc_info()
            print("type: {0}, value: {1}, traceback: {2}".format(type_, value_, traceback_))

    def Stop(self):
        if self._thread is not None:
            self._isRunning = False
            self._thread.do_run = False

    def _isShutDownSet(self):
        if self._shutdownEvent is None:
            return False
        else:
            return self._shutdownEvent.is_set()

    def WorkerProcess(self):
        startTime = time.time()
        while self._isRunning:
            state = self.StateFactory()
            if state is not None:
                self.ExecuteState(state)
            sleep(self._recurringInterval)
            elapsedTime = time.time() - startTime
            if self._timeout > 0 and elapsedTime > self._timeout:
                print("timeout {0} (sec) reached, stop now.".format(self._timeout))
                self.Stop()
                break
            if self._isShutDownSet():
                self.Stop()
                break


    def ExecuteState(self, state):
        if state is None:
            return
        try:
            EventHandler().addEvent(Consts.STATE_COMPLETE_EVENT, self.onStateComplete)
            state.Excute()
        except:
            type_, value_, traceback_ = sys.exc_info()
            print("type: {0}, value: {1}, traceback: {2}".format(type_, value_, traceback_))
            pass
        finally:
            pass

    def onStateComplete(self, sender):
        try:
            state = self.StateFactory(sender)
            if state is not None:
                self.ExecuteState(state)
        finally:
            EventHandler().removeEvent(Consts.STATE_COMPLETE_EVENT)
            pass
'''
def threadTestFunction(arg):
    for i in range(arg):
        print "{0} : running".format(i)
        sleep(1)

if __name__ == '__main__':
    thread = Thread(target = threadTestFunction, args = (10,))
    thread.start()
    thread.join()
    print "thread finished...exiting"
'''
