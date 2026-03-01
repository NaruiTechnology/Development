from abc import abstractmethod
import subprocess

from amaranth import Const
from AutomationPy.buildingblocks.workflow.workstate import WorkState
import os
from AutomationPy.buildingblocks.definitions import Consts
import asyncio

@abstractmethod
class loadFpgaImage_state(WorkState):
    def __init__(self, parent):
        self._last_output = ""
        super(loadFpgaImage_state, self).__init__(parent)
    
    @property
    def last_output(self):
         return self._last_output
    
    def __str__(self):
        return self._last_output
    
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
    
    async def runCommand(self, cmd, dirFrom = None, *args):
        success = True
        cwd = os.getcwd()
        runfrom = cwd
        if dirFrom is not None and os.path.isdir(dirFrom):
            runfrom = dirFrom

        command = cmd
        if args:
            command += " " + " ".join(args)

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
        return success

    async def commandAsyncio(self, cmd, dirFrom = None, *args):
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
                print(stdout.decode())
            success = proc.returncode == 0
        except Exception as e:
            self._last_output = str(e)
            print("Error running command: {}, error:{}".format(cmd, e))
            success = False
        finally:
            os.chdir(cwd)
        return success
