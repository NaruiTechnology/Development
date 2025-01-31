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
import logging
import os as os
from buildingblocks.utils import InvalidArgumentException

'''
    This class has bas been implemented using the Singleton designs pattern
'''


class AutomationLog(object):
    _instancePaeAutomationLog = None

    def __new__(cls, *args, **kwargs):
        if not cls._instancePaeAutomationLog:
            cls._instancePaeAutomationLog = super(AutomationLog, cls).__new__(cls)
            cwd = os.getcwd()
            fileName = r'automation.log'
            if args.__len__() > 0:
                fileName = args[0] + '.log'
            cls._automationLogfile = os.path.join(cwd, fileName)
            logging.basicConfig(level=logging.DEBUG,
                                format='%(asctime)s %(name)-12s %(levelname)-8s %(message)s',
                                datefmt='%m-%d %H:%M',
                                filename=cls._automationLogfile,
                                filemode='a')
            cls._logDictionary = {}
        return cls._instancePaeAutomationLog


    @classmethod
    def GetFileName(cls):
        return cls._automationLogfile


    @classmethod
    def GetFormater(cls):
        return logging.Formatter('%(name)-12s: %(levelname)-8s %(message)s')


    @classmethod
    def GetLogger(cls, name):
        if name is None or name == '':
            return None

        log = cls._logDictionary.get(name)
        if log is None:
            log = logging.getLogger(name)
            cls._logDictionary[name] = log
        return log


    @classmethod
    def Close(cls):
        for key, log in cls._logDictionary.items():  # Simplified iteration
            handlers = log.handlers[:]
            for handler in handlers:
                handler.close()
                log.removeHandler(handler)

    @classmethod
    def TryAddConsole(cls, logname):
        try:
            if logname is None or logname not in cls._logDictionary.keys():
                raise InvalidArgumentException('Cannot find the log from dictionary.')
            console = logging.StreamHandler()
            console.setLevel(logging.INFO)
            formatter = cls.GetFormater()
            console.setFormatter(formatter)
            logging.getLogger(logname).addHandler(console)
        except Exception as e:
            print(str(e))
            raise e
        pass

