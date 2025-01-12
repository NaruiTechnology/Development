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
from abc import abstractmethod
from buildingblocks.decorators import hierarchyValidation
from buildingblocks.workflow.workstate import WorkState
from buildingblocks.decorators import messageBuffer
from buildingblocks.definitions import Consts
import os
import glob
import re


class bkc_automation_state(WorkState):
    @hierarchyValidation(WorkState)
    def __init__(self):
        super(bkc_automation_state, self).__init__()
        self._logger = None
        self._config = None
        self._actionConfig = None
        self.__workdir = os.getcwd()

    @property
    def Logger(self, logger):
        self._logger = logger

    @Logger.setter
    def Logger(self, val):
        self._logger = val

    @property
    def Config(self):
        return self._config

    @Config.setter
    def Config(self, val):
        self._config = val
        key = type(self).__name__.replace(Consts.BKC_STATE_OBJ_PREFIX, '').replace(Consts.BKC_STATE_OBJ_SUFFIX, '')
        for action in self._config.Actions:
            for k, v in action.items():
                if key == k:
                    dataKey = Consts.ACTION_DATA
                    if dataKey in action[key].keys():
                        self._actionConfig = action[key][Consts.ACTION_DATA]
                    break

    @property
    def _workdirectory(self):
        if os.path.isdir(self._config.IfwiBuild[Consts.WORK_DIRECTORY]):
            self.__workdir = self._config.IfwiBuild[Consts.WORK_DIRECTORY]
        return self.__workdir

    @property
    def ActionConfig(self):
        return self._actionConfig

    @messageBuffer
    def NotificationMessage(self, msg):
        pass

    def _findAllBuildOutputFiles(self,  sourceDir):
        buildoutput = list()
        for fileType in ['*.bin', '*.rom']:
            for file in glob.glob(os.path.join(sourceDir, fileType)):
                fileName = os.path.basename(file)
                if re.findall(self._config.BuildOutputFilesPattern, fileName):
                    buildoutput.append(file)
        return buildoutput

    @property
    def _sourceBkcBinaryFile(self):
        buildOutput = self._findAllBuildOutputFiles(self._workdirectory)
        for file in buildOutput:
            fileName = os.path.basename(file)
            if re.match(self._config.IfwiBuild[Consts.SOURCE_BKC_FILE_NAME_PATTERN], fileName):
                return os.path.join(self._workdirectory, fileName)
        return None

    def _fetchBytes(self, offset, size, source, target):
        byteCount = 0
        CHUNK = 4096
        source.seek(offset, 0)
        while byteCount < size:
            byte = source.read(CHUNK)
            if byte:
                if len(byte) == CHUNK and (byteCount + CHUNK) <= size:
                    target.write(byte)
                    byteCount += CHUNK
                else:
                    for b in byte:
                        try:
                            target.write(b)  # Python 2.7
                        except TypeError:
                            target.write(bytes([b]))  # Python 3
                        byteCount += 1
                        if byteCount == size:
                            break
        return byteCount

    def _updateTransactionStatus(self, status=None):
        actionkey = type(self).__name__
        for x in [Consts.BKC_STATE_OBJ_PREFIX, Consts.BKC_STATE_OBJ_SUFFIX]:
            actionkey = actionkey.replace(x, '')
        if status is None:
            self._config[actionkey][Consts.TRANSCTION_COMPLETE] = self._success
        else:
            self._config[actionkey][Consts.TRANSCTION_COMPLETE] = status
        try:
            self._config.Save()
        except Exception as e:
            self._success = False
            self._logger.error(str(e))

    @abstractmethod
    def DoWork(self):
        raise NotImplementedError("user must implement the DoWork.")
