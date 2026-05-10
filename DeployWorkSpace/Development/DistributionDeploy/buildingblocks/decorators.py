#-------------------------------------------------------------------------------
# Name:
# Purpose:
#
# Author:      liyingho
#
# Created:     06/03/2019
# Copyright:   
# Licence:     <your licence>
#-------------- -----------------------------------------------------------------
import time


def overrides(interfaceClass):
    def overrider(method):
        assert(method.__name__ in dir(interfaceClass))
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

