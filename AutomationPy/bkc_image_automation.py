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
import os
from workthreads.bkc_automation_thread import bkc_automation_thread
from buildingblocks.automation_config import AutomationConfig
from buildingblocks.automation_log import AutomationLog
import msvcrt
import time


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('-j', action='store', dest='jsonfile', help="Config Json file path", default=None)
    parser.add_argument('-l', action='store', dest='logname', help="Log file name", default='FDBinAutomation')

    args = parser.parse_args()
    if args.jsonfile is not None:
        jsonpath = args.jsonfile
    else:
        jsonpath = os.path.realpath(r'Json/default_image_automation_config.json')
    config = AutomationConfig(jsonpath)
    logname = args.logname
    automationlogInstance = AutomationLog(config.LogName)
    automationlog = AutomationLog(logname)
    logger = automationlogInstance.GetLogger(logname)
    automationlog.TryAddConsole(logname)
    thread = bkc_automation_thread(config, logger)
    thread.Start()
    if not config.OneTimeOnly:
        try:
            while True:
                if msvcrt.kbhit():
                    char = msvcrt.getch()
                    if str(char).lower() == 'q':
                        thread.Stop()
                        break
                import winsound
                winsound.Beep(1440, 250)
                time.sleep(1)
        except KeyboardInterrupt as kbEx:
            thread.Stop()
        except Exception as e:
            print(str(e))
