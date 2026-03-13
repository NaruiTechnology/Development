import os
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from GlasgowDataIO.workthreads.streamDataThread import streamDataThread
import asyncio
from EsmBeamController.Software.lib.glasgow.hardware.device import GlasgowDevice    

async def main():
    import argparse
    parser = argparse.ArgumentParser(description='Load FPGA image onto the device.')
    parser.add_argument('-j', action='store', dest='jsonfile', help="Config Json file path", default=os.path.realpath(r'./Development/GlasgowDataIO/Json/streamData.json'))
    parser.add_argument('-w', action='store', dest='waveForm', help="Wave form [square, sine, triangle, custom]", default='square')
    parser.add_argument('-d', action='store', dest='data', help="Stream data", default="00.0, 1, 2, 5, 8, 9, 10,0.0, 1, 2, 5, 8, 9, 10,0.0, 1, 2, 5, 8, 9, 10,0.0, 1, 2, 5, 8, 9, 10")
    parser.add_argument('-g', action='store', dest='deviceId', help="Glasgow device Id", default='C3-20251207T145552Z')

    args = parser.parse_args()
    if args.jsonfile is not None:
        jsonpath = args.jsonfile
    if args.deviceId is not None:
        deviceId = args.deviceId
    else:
        deviceId = None
    
    if args.waveForm not in ['square', 'sine', 'triangle']:
        raise ValueError(f'The input parameter [{args.waveForm}] is invalid.')
    data = None
    if args.data is not None:
        print(f'Input data = {args.data}')
        #data = [int(x) for x in args.data.split(",")]
        data = [x for x in args.data.split(",")]
        print(f'---------------------------------\n') 
        print(data) 
       
    config = AutomationConfig(jsonpath)
    sream_inst = streamDataThread(config, deviceId, args.waveForm, data) 
    sream_inst.Start()
            
if __name__ == '__main__':
    asyncio.run(main())