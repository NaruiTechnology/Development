import os
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from GlasgowDataIO.workthreads.readDataThread import readDataThread
import asyncio

async def main():
    import argparse
    parser = argparse.ArgumentParser(description='Load FPGA image onto the device.')
    parser.add_argument('-j', action='store', dest='jsonfile', help="Config Json file path", default=os.path.realpath(r'./Development/GlasgowDataIO/Json/default.json'))
    parser.add_argument('-g', action='store', dest='deviceId', help="Glasgow device Id", default='C3-20251207T145552Z')

    args = parser.parse_args()
    if args.jsonfile is not None:
        jsonpath = args.jsonfile
    if args.deviceId is not None:
        deviceId = args.deviceId
    else:
        deviceId = None      
    config = AutomationConfig(jsonpath)
    read_inst = readDataThread(config, deviceId) 
    read_inst.Start()

if __name__ == '__main__':
    asyncio.run(main())