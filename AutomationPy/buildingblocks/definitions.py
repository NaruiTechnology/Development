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
from enum import Enum
from AutomationPy.buildingblocks.utils import InvalidArgumentException

class LengthType(Enum):
    def __str__(self):
        return self.value
    METER = 'm'
    MIL_METER = 'mm'
    CENT_METER = 'cm'
    KILO_METER = 'km'
    YARD = 'yd'
    FOOT = 'ft'
    INCH = 'in'
    MILE = 'mi'


class RESULTS(Enum):
    def __str__(self):
        return self.value
    PASSED = 'PASSED'
    FAILED = 'FAILED'
    SKIPPED = 'SKIPPED'
    UNKNOWN = 'UNKNOWN'

class LengthMetric:
    def __getitem__(self, index):
        if index is None or not (type(index) is LengthType):
            raise InvalidArgumentException(index)

        return {LengthType.MIL_METER: 1000.0,
                LengthType.CENT_METER: 100.0,
                LengthType.KILO_METER: 0.001,
                LengthType.INCH: 39.3701,
                LengthType.FOOT: 3.28084,
                LengthType.YARD: 1.09361,
                LengthType.MILE: 0.000621371}[index]

class Consts:
    STATE_COMPLETE_EVENT = 'StateComplete'
    """ BKC_AUTOMATION_PACKAGE = 'bkc_automation_state'
    BKC_STATE_OBJ_PREFIX = 'bkc_automation_'
    """    
    STATE_OBJ_SUFFIX = '_state'
    ACTION_DATA = 'actionData'
    BACKUP = 'Backup'
    SKIP = 'skip'
    REGEX_GUILD_PATTERN = '(\{){0,1}[0-9a-fA-F]{8}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{12}(\}){0,1}'


