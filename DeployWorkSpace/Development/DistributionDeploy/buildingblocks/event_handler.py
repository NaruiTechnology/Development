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

from threading import Lock


class Event:
    def __init__(self):
        self._observerDictionary = {}
        pass

    def __iadd__(self, args):
        if args is not None and len(args) > 1:
            key = args[0]
            value = args[1]
            observers = list()
            if key in self._observerDictionary.keys():
                observers = self._observerDictionary[key]
            observers.append(value)
            self._observerDictionary[key] = observers
        return self

    def __isub__(self, args):
        if args is not None and len(args) > 0:
            key = args[0]
            if key in self._observerDictionary.keys():
                for observer in self._observerDictionary.items():
                    del observer
                self._observerDictionary.pop(key, None)
        return self

    def __call__(self, *args, **kvargs):
        if(args is not None and len(args) > 0):
            key = args[0]
            if key in self._observerDictionary.keys():
                observers = self._observerDictionary[key]
            for observer in observers:
                param = None
                if len(args) > 1:
                    param = args[1]
                observer(param)

class EventHandler(object):
    _instanceEventHandler = None

    def __new__(cls, *args, **kwargs):
        if not cls._instanceEventHandler:
            cls._instanceEventHandler = super(EventHandler, cls).__new__(cls, *args, **kwargs)
            cls._invokeSerialMutex = Lock()
            cls._event = Event()
        return cls._instanceEventHandler;

    @classmethod
    def addEvent(cls, *args):
        cls._event += args

    @classmethod
    def removeEvent(cls, *args):
        cls._event -= args

    @classmethod
    def callback(cls, *args, **kvargs):
        cls._event(*args, **kvargs)


