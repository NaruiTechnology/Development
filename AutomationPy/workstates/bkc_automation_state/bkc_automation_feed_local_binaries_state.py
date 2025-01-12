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
from workstates.bkc_automation_state.bkc_automation_state import bkc_automation_state
from buildingblocks.decorators import hierarchyValidation
from buildingblocks.definitions import Consts
import os
import shutil
import re
import glob


class bkc_automation_feed_local_binaries_state(bkc_automation_state):
    @hierarchyValidation(bkc_automation_state)
    def DoWork(self):
        bkcBinariesFolder = self._setupLocalFolders()
        if not self._success:
            return

        try:
            guidDictionary = {}
            for key, val in self._actionConfig[Consts.REGIONS_MAP].items():
                targetName = val[Consts.OUTPUT_NAME]
                targetFolder = val[Consts.OUTPUT_FOLDER]
                guid = val[Consts.GUID].lower()
                if not re.match(Consts.REGEX_GUILD_PATTERN, guid):
                    self._logger.warning('{} is not a valid GUID for {}'.format(guid, key))
                    guid = self._actionConfig['DefaultGuid'][targetFolder].lower()
                    if guid is None or guid != '' or not re.match(Consts.REGEX_GUILD_PATTERN, guid):
                        self._logger.info('Using the default GUID [{}] of {}'.format(guid, key))
                    else:
                        continue
                method = val[Consts.METHOD]
                if method in Consts.RAW_BINARY_METHODS:
                    sourceSearchPattern = '*.raw'
                elif method in Consts.DRIVER_METHODS:
                    sourceSearchPattern = '*.pe'
                if sourceSearchPattern is not None:
                    regionInfo = RegionInfo(guid,
                                            sourceSearchPattern,
                                            os.path.join(bkcBinariesFolder, targetFolder, targetName))
                    guidDictionary[guid] = regionInfo
                else:
                    self._logger.error('The pattern for file type, e.g *.raw, *.pe for the method used by {} '
                                       'must be specified'.format(key))

            biosDumpFolder = os.path.join(self._workdirectory,
                                           Consts.AUTOMATION_WORKSPACE,
                                           Consts.BIOS_DUMP)
            volumeFolders = [os.path.join(biosDumpFolder, x) for x in os.listdir(biosDumpFolder)
                             if os.path.isdir(os.path.join(biosDumpFolder, x))]
            for searchDir in volumeFolders:
                for guid in guidDictionary.keys():
                    self._copyBkcBinary(guidDictionary[guid], searchDir)
        except IOError as e:
            msg = str(e)
            self.NotificationMessage(msg)
            self._logger.error(msg)
            self._success = False
    '''
        Recursive walk the BIOS dump tree to find the region source image and copy to the BKCBinaries foler
    '''
    def _copyBkcBinary(self, regionInfo, biosDumpDir):
        if regionInfo is None:
            return

        for dir in os.walk(biosDumpDir):
            for x in dir:
                if type(x) is list:
                    for next in x:
                        nextDir = os.path.join(biosDumpDir, next)
                        if regionInfo.Guid == next.replace('file-', ''):
                            if not os.path.isfile(regionInfo.Distination):
                                source = glob.glob(os.path.join(nextDir, regionInfo.SourceSearchPattern))
                                if len(source) > 0 and os.path.isfile(source[0]):
                                    shutil.copy(source[0], regionInfo.Distination)
                                    depex = glob.glob(os.path.join(nextDir, '*.depex'))
                                    if len(depex) > 0:
                                        shutil.copy(depex[0], regionInfo.Distination.replace('.bin', '.depex'))
                                self._copyBkcBinary(None, None)
                        self._copyBkcBinary(regionInfo, nextDir)

    def _setupLocalFolders(self):
        try:
            bkcBinariesFolder = self._config.IfwiBuild[Consts.BKC_BINARIES_OUTPUT]
            if os.path.isdir(bkcBinariesFolder):
                bkcBinariesFolder = os.path.join(bkcBinariesFolder, Consts.BKC_BINARIES_OUTPUT)
            else:
                currentFolder = os.getcwd()
                self._logger.warning('The distination folder [{}] from config Json does not exists, '
                                     'redirect the output to current folder [{}]'.format(bkcBinariesFolder,
                                                                                         currentFolder))
                bkcBinariesFolder = os.path.join(currentFolder, Consts.BKC_BINARIES_OUTPUT)

            if not os.path.isdir(bkcBinariesFolder):
                os.mkdir(bkcBinariesFolder)

            workSpace = os.path.join(self._workdirectory, Consts.AUTOMATION_WORKSPACE)
            if not os.path.exists(workSpace):
                os.mkdir(workSpace)

            for k, v in self._actionConfig[Consts.REGIONS_MAP].items():
                path = os.path.join(bkcBinariesFolder, v[Consts.OUTPUT_FOLDER])
                if not os.path.exists(path):
                    os.mkdir(path)
                for f in os.listdir(path):
                    x = os.path.join(path, f)
                    if os.path.isfile(x):
                        os.remove(x)
            return bkcBinariesFolder
        except IOError as e:
            msg = str(e)
            self.NotificationMessage(msg)
            self._logger.error(msg)
            self._success = False


class RegionInfo:
    def __init__(self, guid, sourceSearchPattern, distination):
        self._guid = guid
        self._sourceSearchPattern = sourceSearchPattern
        self._distination = distination

    @property
    def Guid(self):
        return self._guid

    @property
    def SourceSearchPattern(self):
        return self._sourceSearchPattern

    @property
    def Distination(self):
        return self._distination
