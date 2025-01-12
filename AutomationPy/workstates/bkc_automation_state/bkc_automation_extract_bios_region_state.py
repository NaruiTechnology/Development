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
from workstates.bkc_automation_state.bkc_automation_state import bkc_automation_state
from buildingblocks.decorators import hierarchyValidation
from datamodels.BIOSImages.ifwi_image import IfwiImage
from buildingblocks.definitions import Consts
import os
import re


class bkc_automation_extract_bios_region_state(bkc_automation_state):
    @hierarchyValidation(bkc_automation_state)
    def DoWork(self):
        try:
            sourceBkcImage = self._sourceBkcBinaryFile
            if sourceBkcImage is None or not os.path.isfile(sourceBkcImage):
                self._logger.error('There is no input BKC file for extracting BIOS images')
                self._success = False
                return

            extractedImage = os.path.join(self._workdirectory,
                                          Consts.AUTOMATION_WORKSPACE,
                                          self._config.IfwiBuild[Consts.EXTRACTED_BIOS_IMAGE])
            workSpace = os.path.join(self._workdirectory, Consts.AUTOMATION_WORKSPACE)
            if not os.path.exists(workSpace):
                os.mkdir(workSpace)
            if os.path.isfile(sourceBkcImage):
                self._logger.info("Extract BIOS region from {} to {}.".format(sourceBkcImage, extractedImage))
                bkcIfwi = IfwiImage(sourceBkcImage, self._logger)
                with open(extractedImage, 'wb') as outputfile:
                    with open(sourceBkcImage, 'rb') as openfileIfwiTemplate:
                        self._fetchBytes(bkcIfwi.BiosStartAddress, bkcIfwi.BiosSize, openfileIfwiTemplate, outputfile)
        except Exception as e:
            msg = str(e)
            self.NotificationMessage(msg)
            self._logger.error(msg)
            self._success = False

