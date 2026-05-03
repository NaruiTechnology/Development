#-------------------------------------------------------------------------------
# Name:        module1
# Purpose:
#
# Author:      liyingho
#
# Created:     07/13/2019
# Copyright:   (c) liyingho 2017
# Licence:     <your licence>
#-------------------------------------------------------------------------------
from abc import abstractmethod

class Invoke():
    @abstractmethod
    def InvokeIpmiTool(self, params):
        raise NotImplementedError("user must implemente the IntialWork.")

    @abstractmethod
    def InvokeIpmiRaw(self,  manuID, command, params, outFile = None):
        raise NotImplementedError("user must implemente the IntialWork.")
