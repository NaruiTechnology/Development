from abc import abstractmethod

from Development.AutomationPy.buildingblocks.decorators import overrides
from Development.AutomationPy.buildingblocks.workflow.workstate import WorkState

import asyncio
import os

class LoadFPGAState(WorkState):
    def __init__(self, parent):
        self._last_output = ""
        super(LoadFPGAState, self).__init__(parent)
    
    @property
    def last_output(self):
        """Returns the stdout from the last command execution."""
        return self._last_output
    
    def __str__(self):
        """Returns the last command output/error message as string."""
        return self._last_output
    
    async def runCommand(self, cmd, dirFrom = None, *args):
        success = False
        cwd = os.getcwd()
        runfrom = cwd
        if dirFrom is not None and os.path.isdir(dirFrom):
            runfrom = dirFrom

        command = cmd
        if args:
            command += " " + " ".join(args)

        try:
            os.chdir(runfrom)
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT)
            stdout, _ = await proc.communicate()
            self._last_output = stdout.decode('utf-8') if stdout else ""
            success = proc.returncode == 0
        except Exception as e:
            self._last_output = str(e)
            print("Error running command: {}, error:{}".format(command, e))
            success = False
        finally:
            os.chdir(cwd)
        return success
    
