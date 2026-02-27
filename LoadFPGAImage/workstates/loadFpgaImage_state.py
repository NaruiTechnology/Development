from abc import abstractmethod
import subprocess

from AutomationPy.buildingblocks.workflow.workstate import WorkState

import asyncio
import os

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
    


""" class loadFpgaImage_state(object):
    def __init__(self, parent):
        super(loadFpgaImage_state, self).__init__(parent) """