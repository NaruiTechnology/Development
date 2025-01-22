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
import sys, os
sys.path.append(os.path.split(os.path.dirname(os.getcwd()))[0])
import unittest
import buildingblocks.unittest.test_buildingblocks as tsBuildingblocks
import buildingblocks.unittest.test_decoders as tsDecoders

loader = unittest.TestLoader()
suite = unittest.TestSuite()
suite.addTest(loader.loadTestsFromModule(tsBuildingblocks))
suite.addTest(loader.loadTestsFromModule(tsDecoders))

runner = unittest.TextTestRunner(verbosity=3)
result = runner.run(suite)
