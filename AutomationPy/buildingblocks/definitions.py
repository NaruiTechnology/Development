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


class Consts:
    STATE_COMPLETE_EVENT = 'StateComplete'
    BKC_AUTOMATION_PACKAGE = 'bkc_automation_state'
    BKC_STATE_OBJ_PREFIX = 'bkc_automation_'
    BKC_STATE_OBJ_SUFFIX = '_state'
    ACTION_DATA = 'actionData'
    TRANSCTION_COMPLETE = 'transactionComplete'
    WORK_DIRECTORY = 'Input'
    AUTOMATION_WORKSPACE= 'AutomationWorkSpace'
    BIOS_DUMP = 'BiosDump'
    EXTRACTED_BIOS_IMAGE = 'ExtractedBiosImage'
    BACKUP = 'Backup'
    SKIP = 'skip'
    REGIONS_MAP = 'RegionsMap'
    BKC_BINARIES_OUTPUT = 'BKCBinaries'
    SOURCE_BKC_FILE_NAME_PATTERN = 'SourceBkcFileNamePattern'
    GUID = 'GUID'
    METHOD = 'Method'
    COMPLETED_MSG = '--- Completed ---'
    FAILED_MSG = '--- Failed ---'
    OUTPUT_FOLDER = 'OutputFolder'
    OUTPUT_NAME = 'OutputName'
    RAW_BINARY_METHODS = "['RAW', 'FREEFORM', 'RawDATA']"
    DRIVER_METHODS = "['DRIVER']"
    REGEX_GUILD_PATTERN = '(\{){0,1}[0-9a-fA-F]{8}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{12}(\}){0,1}'


