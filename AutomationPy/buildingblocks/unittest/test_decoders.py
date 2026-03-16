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
import time
import unittest 
from abc import abstractmethod
from ..decorators import declarative, initializer, overrides
from ..decorators import callCount
from ..decorators import timeElapseTimer
from ..decorators import messageBuffer


class my_class_with_timeout_function:
    def __init__(self):
        self._success = True
        self._timeoutTimer(0, True)
        self._config = 'Json config'
        self._serialport = None

    @timeElapseTimer
    def _timeoutTimer(self, timeout, reset):
        print('Call _timeoutTimer, timeout={}'.format(timeout), 'reset={}'.format(reset))
        return self._timeoutTimer.isTimeout

    def _checkTimeout(self, timeout, reset=False):  # timeout in seconds, reset = False
        self._success = True
        if self._timeoutTimer(timeout, reset):
            self._success = False
            print('Timeout = {0}sec reached.'.format(timeout))

    @declarative
    def _SerialPortConnection(self):
        print('Connecting serial port.')
        self._serialport = object()
        return self._serialport

    SerialPortConnection = property(*_SerialPortConnection)

    @abstractmethod
    def DoWork(self):
        raise NotImplementedError("users must implement the DoWork method!")

    @messageBuffer
    def NotificationMessage(self, msg):
        print('Add message [{}] to message buffer.'.format(msg))



class myDerivedClass(my_class_with_timeout_function):
    @overrides(my_class_with_timeout_function)
    def DoWork(self):
        print("In overrides methods.")
    '''
    This is the usage for overrides decorater when a derived class
    missing the parameter of its base class and the mistakes will be caught at run time
    '''

    try:
        class myDerivedClassInError(my_class_with_timeout_function):
            @overrides() # missing the base calss as parameter
            def DoWork(self):
                pass
    except Exception as e:
        print(str(e))


class test_decoders(unittest.TestCase, my_class_with_timeout_function):
    def test_intializerDecorator(self):
        myderivedCls = myDerivedClass()
        conn = myderivedCls.SerialPortConnection
        conn2 = myderivedCls.SerialPortConnection
        self.assertEqual(conn, conn2)
        myderivedCls.SerialPortConnection = conn2
        conn3 = conn2
        self.assertEqual(conn, conn3)
        del myderivedCls.SerialPortConnection

    def test_overridsDecoraterSuccess(self):
        concretClass = myDerivedClass()
        self.assertFalse(concretClass is None)
        concretClass.DoWork()

    @unittest.expectedFailure
    def test_callAbstractMethod(self):
        baseClass = my_class_with_timeout_function()
        self.assertFalse(baseClass is None)
        baseClass.DoWork()

    def test_MyClassWithTimeoutFunction(self):
        myClass = my_class_with_timeout_function()
        self.assertFalse(myClass is None)

    def test_MessageBufferDecorater(self):
        myConcretClass = myDerivedClass()
        self.assertEqual(0, len(myConcretClass.NotificationMessage.content))
        for x in range(0, 3):
            myConcretClass.NotificationMessage('Message_{}'.format(x))
        self.assertEqual(3, len(myConcretClass.NotificationMessage.content))

    def test_callCount(self):
        print('\n')
        n = 3
        for i in range(0, n):
            print(self._greetings())
        self.assertEqual(n, self._greetings.count)

    @callCount
    @initializer
    def _greetings(self):
        return 'Calling function _greetings #{}.'.format(self._greetings.count)

    def test_timeout_yes(self):
        timeout = 5
        delay = 6
        self._checkTimeout(timeout, True)  # reset the timer
        '''
            Do something with long last time
        '''
        self._delay(delay)
        self._checkTimeout(timeout)
        self.assertEqual(False, self._success)

    def test_timeout_no(self):
        timeout = 10
        delay = 1
        self._checkTimeout(timeout, True)  # reset the timer
        self._delay(delay)
        self._checkTimeout(timeout)
        self.assertEqual(True, self._success)

    def _delay(self, timeout):
        start = time.time()
        while True:
            now = time.time()
            if now - start > timeout:
                break

