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


class bkc_automation_verify_build_exists_state(bkc_automation_state):
    @hierarchyValidation(bkc_automation_state)
    def DoWork(self):
        self._success = self._sourceBkcBinaryFile is not None






