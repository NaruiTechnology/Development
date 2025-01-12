#-------------------------------------------------------------------------------
# This file contains 'Framework Code' and is licensed as such
# under the terms of your license agreement with Intel or your
# vendor. This file may not be modified, except as allowed by
# additional terms of your license agreement.
#
## @file
#
# Copyright (c) 2019, Intel Corporation. All rights reserved.
# This software and associated documentation (if any) is furnished
# under a license and may only be used or copied in accordance
# with the terms of the license. Except as permitted by such
# license, no part of this software or documentation may be
# reproduced, stored in a retrieval system, or transmitted in any
# form or by any means without the express written consent of
# Intel Corporation.
#-------------- -----------------------------------------------------------------
from workstates.bkc_automation_state.bkc_automation_state import bkc_automation_state
from buildingblocks.decorators import hierarchyValidation
from buildingblocks.definitions import Consts
import os
import shutil


class bkc_automation_cleanup_state(bkc_automation_state):
    @hierarchyValidation(bkc_automation_state)
    def DoWork(self):
        biosDumpPath = os.path.join(self._workdirectory, Consts.AUTOMATION_WORKSPACE)
        try:
            if biosDumpPath is not None and os.path.isdir(biosDumpPath):
                shutil.rmtree(biosDumpPath)

            inputBkcFile = self._sourceBkcBinaryFile
            if os.path.isfile(inputBkcFile):
                os.remove(inputBkcFile)
        except IOError as e:
            msg = str(e)
            self.NotificationMessage(msg)
            self._logger.error(msg)
            self._success = False


