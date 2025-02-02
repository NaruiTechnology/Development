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
import sys, os
sys.path.append(os.path.split(os.path.dirname(os.getcwd()))[0])
import pyipmi
import pyipmi.interfaces
from pyipmi import Target
from buildingblocks.Decoraters import overrides
from buildingblocks.invoke import Invoke
from time import sleep
import utils as util

class InvokePyipmiTool(Invoke):
    def __init__(self,
                host,
                user,
                password,
                bridge = None,#0x06,
                target = None,#0x2c,
                port = 623,
                toolname = 'ipmitool',
                interfacetype = 'lanplus',
                delay = 1):
        self._interfacetype = interfacetype
        self._delay = delay
        try:
            interface = pyipmi.interfaces.create_interface(toolname, self._interfacetype)
            self._target = None
            if target is not None:
                self._target = Target(target)
            connection = pyipmi.create_connection(interface)
            connection.target = self._target
            if target is not None:
                connection.target.set_routing([(0, bridge)])
                connection.session.set_session_type_rmcp(host, port)
                connection.session.set_auth_type_user(user, password)
            connection.session.establish()
            self._connection = connection
            self._interface = interface
            self._rc = 0
        except Exception as e:
            self._connection = None
            print(str(e))

    @overrides(Invoke)
    def InvokeIpmiTool(self, params):
        output, rc = self._interface.rmcp_invoke(params)
        self._rc = rc
        return output

    @overrides(Invoke)
    def InvokeIpmiRaw(self, manuID, command, params, outFile = None):
        if self._connection is None:
            return None
        split = command.split(' ')

        rawbytes = util.FormatRawbytes(manuID, split, params)
        data, rc = self._connection.session._interface.send_and_receive_raw(self._target,
                                                                        0, # lun
                                                                        int(split[0], 16),#netfn
                                                                        rawbytes)
        sleep(1)

        self._rc = rc
        if outFile is not None:
            outFile.write(data)
            outFile.flush()
        return data
