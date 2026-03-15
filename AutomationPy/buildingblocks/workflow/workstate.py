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

from abc import abstractmethod
from ..event_handler import EventHandler
from ..definitions import Consts
from ..utils import *
import inspect, subprocess, asyncio


class WorkstateMetaClass(type):
    def __new__(cls, name, parents, dct):
        # create a class_id if it's not specified
        if 'class_id' not in dct:
            dct['class_id'] = name.lower()
        # we need to call type.__new__ to complete the initialization
        return super(WorkstateMetaClass, cls).__new__(cls, name, parents, dct)


class WorkState(object):# abstract base class
    __metaclass__ = WorkstateMetaClass
    file = __file__

    def __init__(self, parent, *args, **kwargs):
        self._success = False
        self._id = repr("WorkState_" + IdGenerator())
        self._parentWorkThread = parent
        self._configTest = None
        self._outfile = None
        self._invokeFactory = None
        self._stdout = None
        self._stderr = None

    @property
    def Id(self):
        return self._id

    def GetInvoke(self, device=None):
        if self._invokeFactory is None:
            return None
        invoke =  self._invokeFactory.DefaultDevice()
        if not device is None:
            invoke = self._invokeFactory.Get(device)
        return invoke

    @property
    def ParentWorkThread(self):
        return self._parentWorkThread

    @ParentWorkThread.setter
    def ParentWorkThread(self, val):
        if val is not None and type(val).__name__.lower().endswith('thread'):
            self._parentWorkThread = val
            #self._invokeFactory = val.GetInvokeFactory()
            self._config = val._config

    @property
    def Success(self):
        self._success

    @Success.setter
    def Success(self, val):
        self._success = val

    async def Execute(self):
        try:
            if inspect.iscoroutinefunction(self.DoWork):
                await self.DoWork()
            else:
                self.DoWork()
        except Exception as e:
            print("!!!! error at Execute, error %s" % str(e))
            self._success = False

    def LogMessage(self, msg):
        print (msg)
        if self._outfile is not None:
            self._outfile.write(msg)
            self._outfile.flush()

    def formatCommand(self, stateConfig):
        if not stateConfig or Consts.COMMAND_FORMAT not in stateConfig[Consts.ACTION_DATA]:
            return None
        
        command_format = stateConfig[Consts.ACTION_DATA][Consts.COMMAND_FORMAT]
        positional_values = [v for k, v in stateConfig[Consts.ACTION_DATA].items() if k != Consts.COMMAND_FORMAT]
        try:
            formatted_command = command_format.format(*positional_values)
            return formatted_command
        except (IndexError, KeyError) as e:
            print(f"Error formatting command: {e}")
            return None
    
    async def runCommand(self, cmd, dirFrom = None):
        success = True
        cwd = os.getcwd()
        runfrom = cwd
        if dirFrom is not None and os.path.isdir(dirFrom):
            runfrom = dirFrom
        command = cmd
        try:
            os.chdir(runfrom)
            
            params = command.split(" ")
            proc = subprocess.Popen(params,
                                    cwd=runfrom,
                                    stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE,
                                    text=True)
            if proc.returncode != 0:
                self._last_output = proc.stdout 
            success = proc.returncode == 0
        except Exception as e:
            self._last_output = str(e)
            print("Error running command: {}, error:{}".format(command, e))
            success = False
        finally:
            os.chdir(cwd)
            self._stdout = proc.stdout
            self._stderr = proc.stderr
        return success

    async def commandAsyncio(self, cmd, dirFrom = None, verbose=False): #*args):
        success = True
        cwd = os.getcwd()
        runfrom = cwd
        if dirFrom is not None and os.path.isdir(dirFrom):
            runfrom = dirFrom

        try:
            os.chdir(runfrom)
            
            proc = await asyncio.create_subprocess_shell(
                        cmd,
                        cwd=runfrom,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        env=os.environ.copy() # Ensures toolchain paths are inherited
                    )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                self._last_output = stderr.decode() 
            else:
                if verbose:
                    print(stdout.decode())
            success = proc.returncode == 0
        except Exception as e:
            self._last_output = str(e)
            print("Error running command: {}, error:{}".format(cmd, e))
            success = False
        finally:
            os.chdir(cwd)
            self._stdout = stdout
            self._stderr = stderr
        return success

    @abstractmethod
    def DoWork(self):
        raise NotImplementedError("users must implement the DoWork method!")
