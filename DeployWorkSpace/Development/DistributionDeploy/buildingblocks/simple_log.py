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
from datetime import datetime as d
import os


class SimpleLog(object):
    ts = d.now().strftime('%Y-%m-%d-%H-%M-%S')

    def __init__(self, path='./', name='debug.log'):
        if self._file is None:
            if not os.path.isdir(path):
                os.mkdir(path)
            self._file = open('{0}\\{1}_{2}'.format(path.rstrip('\\'), SimpleLog.ts, name), 'w')

    def __del__(self):
        self.close()

    def info(self, str):
        stamp = d.now().strftime('%Y-%m-%d-%H-%M-%S')
        fmt_str = '[Info] [%s] %s\n' % (stamp, str)
        self._file.write(fmt_str)
        self._file.flush()
        print (fmt_str)

    def error(self, str):
        stamp = d.now().strftime('%Y-%m-%d-%H-%M-%S')
        fmt_str = '[Error] [%s] %s\n' % (stamp, str)
        self._file.write(fmt_str)
        self._file.flush()
        print (fmt_str)

    def close(self):
        if not(self._file is None):
            self._file.close()

