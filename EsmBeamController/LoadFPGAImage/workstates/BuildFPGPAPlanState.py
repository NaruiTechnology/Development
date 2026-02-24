from Development.AutomationPy.buildingblocks.decorators import overrides
from Development.EsmBeamController.Software.controller import OBIDemux
from .LoadFPGAState import LoadFPGAImageState
from Software.lib.glasgow.hardware.target import GlasgowHardwareTarget
from Software.lib.glasgow.hardware.multiplexer import DirectMultiplexer
from Software.applets.BeamControlApplet import BeamControlApplet
import os
#from Software.configs.applet import OBIAppletArguments  

class BuildFPGAPlanState(LoadFPGAImageState):
    def __init__(self, context, parent):
        self.context = context
        super(BuildFPGAPlanState, self).__init__(parent)

    @property
    def buildPlan(self):
        return self._buildPlan

    @overrides(LoadFPGAImageState)
    async def DoWork(self):
        target = GlasgowHardwareTarget(revision=self.device.revision, multiplexer_cls=DirectMultiplexer)
        #applet = BeamControlApplet() # target, args)
        self.device.demultiplexer = target.multiplexer 
        fpgaBuildPlan = None
        await fpgaBuildPlan = target.build_plan()
        if fpgaBuildPlan is not None and os.path.exists(os.path.join(fpgaBuildPlan, "top.v")):
            self.parent.fpgaBuildPlan = fpgaBuildPlan
        
        """ args = OBIAppletArguments()
        args.parse_toml()
        args = args.argss
        self.parent.device.demultiplexer = OBIDemux(self.parent.device, target.multiplexer.pipe_count) # target.multiplexer # OBIDemux(device, target.multiplexer.pipe_count)
        self.iface = await self.device.demultiplexer.claim_interface(applet, applet.mux_interface, args,
                                                        read_buffer_size=16384*16384, write_buffer_size=16384*16384)  #1024*1024)
             """

