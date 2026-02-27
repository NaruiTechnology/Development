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
from ..event_handler import EventHandler
from ..definitions import Consts
#import buildingblocks.utils as util
from ..utils import *
import asyncio
import inspect


class WorkstateMetaClass(type):
    def __new__(cls, name, parents, dct):
        # create a class_id if it's not specified
        if 'class_id' not in dct:
            dct['class_id'] = name.lower()
        # we need to call type.__new__ to complete the initialization
        return super(WorkstateMetaClass, cls).__new__(cls, name, parents, dct)


class WorkState(object):# abstract base class
    __metaclass__ = WorkstateMetaClass
    file = __file__

    def __init__(self, parent, *args, **kwargs):
        self._success = False
        self._id = repr("WorkState_" + IdGenerator())
        self._parentWorkThread = parent
        self._configTest = None
        self._outfile = None
        self._invokeFactory = None

    # def __str__(self):
    #     return repr("WorkState_" + self._id)
    @property
    def Id(self):
        return self._id

    def GetInvoke(self, device=None):
        if self._invokeFactory is None:
            return None
        invoke =  self._invokeFactory.DefaultDevice()
        if not device is None:
            invoke = self._invokeFactory.Get(device)
        return invoke

    @property
    def ParentWorkThread(self):
        return self._parentWorkThread

    @ParentWorkThread.setter
    def ParentWorkThread(self, val):
        if val is not None and type(val).__name__.lower().endswith('thread'):
            self._parentWorkThread = val
            #self._invokeFactory = val.GetInvokeFactory()
            self._config = val._config

    @property
    def Success(self):
        self._success

    @Success.setter
    def Success(self, val):
        self._success = val

    """ def GetParentWorkThread(self):
        return self._parentWorkThread

    def SetParentWorkThread(self, val):
        if val is not None and type(val).__name__.lower().endswith('thread'):
            self._parentWorkThread = val
            self._invokeFactory = val.GetInvokeFactory()
            self._config = val._config """

    async def Execute(self):
        try:
            if inspect.iscoroutinefunction(self.DoWork):
                await self.DoWork()
            else:
                self.DoWork()
        except Exception as e:
            print("!!!! error at Execute, error %s" % str(e))
            self._success = False
        """ finally:
            EventHandler().callback(Consts.STATE_COMPLETE_EVENT, self)
 """
    def LogMessage(self, msg):
        print (msg)
        if self._outfile is not None:
            self._outfile.write(msg)
            self._outfile.flush()

    @abstractmethod
    def DoWork(self):
        raise NotImplementedError("users must implement the DoWork method!")
