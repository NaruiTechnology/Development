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
from abc import abstractmethod
from threading import Thread
from time import sleep
import os as os
import sys
import time
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.event_handler import EventHandler
from AutomationPy.buildingblocks.definitions import Consts
import asyncio

class WorkThreadMetaClass(type): 
    def __new__(cls, name, parents, dct):
        if 'class_id' not in dct:
            dct['class_id'] = name.lower()
        return super(WorkThreadMetaClass, cls).__new__(cls, name, parents, dct)

    def __get__(self, obj, objtype):
        import functools
        return functools.partial(self.__call__, obj)


class WorkThread(Thread):
    file = __file__

    def __init__(self):
        super(WorkThread, self).__init__()
        self._queue = None #Queue()
        self._isTerminated = False
        self._timeout = 0  # Seconds, 0 = infinite
        self._recurringInterval = util.DefaultRecurringInterval
        '''
            NOTE: if the timeout value < 0, the life time for a work thread is infinit
        '''
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
        self.start()
        
    def Stop(self):
        self._isTerminated = True

    def _isShutDownSet(self):
        if self._shutdownEvent is None:
            return False
        else:
            return self._shutdownEvent.is_set()

    def run(self, verbose=False):
        # Create ONE persistent loop for this thread's entire lifetime
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        startTime = time.time()
        
        if verbose:
            print(f"Starting Thread: {self.__class__.__name__}")

        state = None
        try:
            while not self._isTerminated:
                if self._timeout > 0 and (time.time() - startTime) > self._timeout:
                    print("Global timeout reached.")
                    break
                
                state = self.StateFactory(state)
                if state is not None:
                    # Run the state within the existing persistent loop
                    loop.run_until_complete(state.Execute())
                else:
                    if verbose:
                        print("No more states to execute. Thread is idle.")
                    self._isTerminated = True                   
                
                # Use the loop to sleep asynchronously or use standard sleep
                time.sleep(self._recurringInterval)
        except Exception as e:
            print(f"Execution Error: {e}")
            self._isTerminated = True
        finally:                    
            # Properly close the hardware and loop once at the very end
            if loop.is_running():
                loop.stop()
            loop.close()            


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
    
    def GetStateConfig(self, state):
        return util.GetStateConfigByName(self._config, type(state).__name__.replace(Consts.STATE_OBJ_SUFFIX, ''))