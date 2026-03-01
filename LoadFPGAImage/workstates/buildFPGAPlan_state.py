
import asyncio
import os
from types import SimpleNamespace

from AutomationPy.buildingblocks.decorators import overrides

from AutomationPy.buildingblocks.definitions import Consts
from EsmBeamController.Software.configs.applet import OBIAppletArguments
from EsmBeamController.Software.lib.glasgow.hardware.multiplexer import DirectMultiplexer
from EsmBeamController.Software.lib.glasgow.hardware.target import GlasgowHardwareTarget
from EsmBeamController.Software.applets.BeamControlApplet import BeamControlApplet
from .loadFpgaImage_state import loadFpgaImage_state

class buildFPGAPlan_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(buildFPGAPlan_state, self).__init__(parent)


    @property
    def buildPlan(self):
        return self._buildPlan

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        args = SimpleNamespace(
            port="A"#,
            #x_pins=[f"{self.port}0"], # PinArgument(0)
            #y_pins=[f"{self.port}1"], # PinArgument(1)
            #operation="run",
            #loopback = True,
            #out_only = False,
            #xflip = False, 
            #yflip = False, 
            #rotate90 = False,
            #ext_switch_delay = 0.5,
            #benchmark = True         
        )
        try:
            device = self.ParentWorkThread.device
            target = GlasgowHardwareTarget(revision=device.revision, multiplexer_cls=DirectMultiplexer)
            applet = BeamControlApplet()
            iface = applet.build(target, args)
            device.demultiplexer = target.multiplexer
            plan = target.build_plan()
            if plan is not None and os.path.exists(os.path.join(plan.buildDir, "top.v")):
                stateConfig = self.ParentWorkThread.GetStateCongig(self)
                if stateConfig is not None and Consts.ACTION_DATA in stateConfig:
                    cmd = self.formatCommand(stateConfig)
                    """ proc = await asyncio.create_subprocess_shell(
                        cmd,
                        cwd=plan.buildDir,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        env=os.environ.copy() # Ensures toolchain paths are inherited
                    )
                    stdout, stderr = await proc.communicate()
                    if proc.returncode != 0:
                        print(f"Command failed with error: {stderr.decode()}")
                        self.Success = False
                    else:
                        print(f"{stdout.decode()}\n------------Command executed successfully.------------")
                        self.ParentWorkThread.fpgaBuildPlan = plan
                        self.Success = True
                        print("Build FPGA plan successfully.")  
 """
                    
                    await self.commandAsyncio(cmd, plan.buildDir)
                    success = self._buildPlanValidation(stateConfig, plan.buildDir) 
                    if success is True:
                        self.Success = True
                        self.ParentWorkThread.fpgaBuildPlan = plan
                        print("Build FPGA plan successfully.")  
        except Exception as e:
            print(f"Build FPGA plan failed with error: {e}")
            self.Success = False        

    def _buildPlanValidation(self, stateConfig, buildDir):
        builSuccess = False
        if Consts.ARGS_DATA in stateConfig:  
            outputFiles = stateConfig[Consts.ARGS_DATA].get("outputFiles", [])
            for outputFile in outputFiles:
                outputPath = os.path.join(buildDir, outputFile)
                if os.path.isfile(outputPath):
                    print(f"Confirmed output file {outputFile} exists at {buildDir}.")
                    builSuccess |= True
                else:
                    print(f"Output file {outputFile} is missing at {buildDir}.")
                    builSuccess &= False  
        return builSuccess       