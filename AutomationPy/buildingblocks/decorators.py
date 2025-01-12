#-------------------------------------------------------------------------------
# This file contains 'Framework Code' and is licensed as such
# under the terms of your license agreement with Intel or your
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
# Intel Corporation.
#-------------- -----------------------------------------------------------------
import time


def hierarchyValidation(class_func):
    def overrider(method):
        assert(method.__name__ in dir(class_func))
        return method
    return overrider


def callCount(func):
    def counter(*args, **kwargs):
        counter.count += 1
        return func(*args, **kwargs)
    counter.count = 0
    counter.__name__ = func.__name__
    return counter


def timeElapseTimer(func):
    def timer(*args, **kwargs):
        timer.isTimeout = True
        if len(args) > 1:
            timeout = args[1]
            if len(args) > 2 and args[2] is True:
                timer.startTime = time.time()
            elapsedTime = time.time() - timer.startTime
            if not (timeout > 0 and elapsedTime > timeout):
                timer.isTimeout = False
        return func(*args, **kwargs)
    timer.startTime = time.time()
    timer.isTimeout = False
    timer.__name__ = func.__name__
    return timer


def messageBuffer(func):
    def buffer(*args, **kwargs):
        if len(args) > 0:
            if args[1] is not None:
                buffer.content.append(args[1])
        return func(*args, **kwargs)
    buffer.content = []
    buffer.__name__ = func.__name__
    return buffer


def initializer(init_method):
    key = "_{}_bf".format(init_method.__name__)

    def mget(self):
        if key not in self.__dict__: self.__dict__[key] = init_method(self)
        return self.__dict__[key]
    return mget


def declarative(init_method):
    key = "_{}_bf".format(init_method.__name__)

    def mget(self):
        if key not in self.__dict__: self.__dict__[key] = init_method(self)
        return self.__dict__[key]

    def mset(self, value):
        self.__dict__[key] = value

    def mdel(self):
        if key in self.__dict__: del self.__dict__[key]

    return mget, mset, mdel

