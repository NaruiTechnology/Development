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
from buildingblocks.decorators import hierarchyValidation
from buildingblocks.workflow.work_thread import WorkThread
from buildingblocks.definitions import Consts
import buildingblocks.utils as util
import sys
try:
    import Queue as queue
except:
    import queue as queue


class bkc_automation_thread(WorkThread):
    @hierarchyValidation(WorkThread)
    def __init__(self, config, logger):
        super(bkc_automation_thread, self).__init__()
        self._config = config
        self._logger = logger
        self._queue = None

    @hierarchyValidation(WorkThread)
    def StateFactory(self, workState=None):
        state = None
        if workState is None:
            state = self.IntialWork()
        elif workState._success:
            if self._queue.qsize() > 0:
                state = self._queue.get_nowait()
            else:
                self._logger.info(Consts.COMPLETED_MSG_FORMAT.format(type(self).__name__))
        else:
            state = None
            self._logger.error(Consts.FAILED_MSG)

        if state is not None:
            self._logger.info('Calling {}'.format(type(state).__name__.replace(Consts.BKC_STATE_OBJ_PREFIX, '')
                                                  .replace(Consts.BKC_STATE_OBJ_SUFFIX, '')))
        elif self._config.OneTimeOnly:
            self.Stop()

        return state

    @hierarchyValidation(WorkThread)
    def Stop(self):
        super(bkc_automation_thread, self).Stop()
        for x in self._config.Actions:
            x.items()[0][1][Consts.TRANSCTION_COMPLETE] = False
        #self._config.Save()

    @hierarchyValidation(WorkThread)
    def IntialWork(self):
        state = None
        self._queue = queue.Queue()

        for action in self._config.Actions:
            for key, val in action.items():
                actionConfig = val
                skip = actionConfig[Consts.SKIP]
                if key == 'BackupIntelBuildOutput' and not self._config.OneTimeOnly:
                    skip = False
                if not skip:
                    instance = util.CreateInstance(key, Consts.BKC_AUTOMATION_PACKAGE)
                    instance.Config = self._config
                    instance.Logger = self._logger
                    self._queue.put(instance)
        if self._queue.qsize() > 0:
            state = self._queue.get_nowait()

        return state


