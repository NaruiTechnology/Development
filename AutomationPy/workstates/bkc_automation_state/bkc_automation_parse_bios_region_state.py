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
from uefi_firmware import AutoParser
from buildingblocks.definitions import Consts
import os
import shutil


class bkc_automation_parse_bios_region_state(bkc_automation_state):
    @hierarchyValidation(bkc_automation_state)
    def DoWork(self):
        try:
            extractedImage = os.path.join(self._workdirectory,
                                          Consts.AUTOMATION_WORKSPACE, self._config.IfwiBuild[Consts.EXTRACTED_BIOS_IMAGE])
            biosDumpPath = os.path.join(self._workdirectory,
                                        Consts.AUTOMATION_WORKSPACE, Consts.BIOS_DUMP)
            if os.path.exists(biosDumpPath):
                shutil.rmtree(biosDumpPath)
            with open(extractedImage, 'rb') as biosimage:
                content = biosimage.read()
                parser = AutoParser(content)
                if parser.type() != 'unknown':
                    fd = parser.parse()
                    fd.dump(biosDumpPath)
                    #fd.showinfo()
        except Exception as e:
            msg = str(e)
            self.NotificationMessage(msg)
            self._logger.error(msg)
            self._success = False



