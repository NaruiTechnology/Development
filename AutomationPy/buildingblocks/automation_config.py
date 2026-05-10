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
import json
import os
from collections import OrderedDict
from json import JSONDecoder


class AutomationConfig(object):
    def __init__(self, source):
        self.__dict__ = OrderedDict()
        if os.path.isfile(source):
            with open(source, 'r') as f:
                jsonString = f.read()
        else:
            jsonString = source
        decoder = JSONDecoder(object_hook=OrderedDict)
        self.__dict__ = decoder.decode(jsonString)  # json.loads(jsonString)
        self._jsonFile = source

    def __getitem__(self, key):
        for k, v in self.__dict__.items():
            if k == key:
                return v
            if type(v) is dict:
                ret = self._getitem(key, v)
                if ret is not None:
                    return ret
            elif type(v) is list:
                for x in v:
                    ret = self._getitem(key, x)
                    if ret is not None:
                        return ret
        return None

    def _getitem(self, key, item):
        if key is None:
            return item
        elif key == item.keys()[0]:
            return item[key]

        if type(item) is dict:
            for k in item.keys():
                if k == key:
                    self._getitem(None, item[k])
        elif type(item) is list:
            for x in item:
                self._getitem(key, x)

    def __setitem__(self, key, val):
        if key not in self.__dict__.keys():
            self.__dict__[key] = val

    def __delitem__(self, key):
        if key in self.__dict__.keys():
            self.__dict__.remove(key)

    def __iter__(self):
        for key in self.__dict__.keys():
            node = self.__dict__[key]
            for x in node.keys():
                yield node[x]

    def __str__(self):
        #return json.dumps(self, default=lambda x: x.__dict__, sort_keys=False, indent=4)
        dic = OrderedDict()
        for k, v in self.__dict__.items():
            if not k.startswith('_'):
                dic[k] = v
        return json.dumps(dic, default=lambda x: x.__dict__, sort_keys=False, indent=4)

    def Save(self):
        if self._jsonFile is not None:
            with open(self._jsonFile, 'w') as f:
                f.write(str(self))

