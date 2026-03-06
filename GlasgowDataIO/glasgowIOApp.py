import os
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from workthreads.readThread import readDataThread
from workthreads.writeDataThread import writeDataThread
import time, asyncio

async def main():
    import argparse
    parser = argparse.ArgumentParser(description='Load FPGA image onto the device.')
    parser.add_argument('-j', action='store', dest='jsonfile', help="Config Json file path", default=os.path.realpath(r'./Development/GlasgowDataIO/Json/default.json'))
    parser.add_argument('-g', action='store', dest='deviceId', help="Glasgow device Id", default='C3-20251207T145552Z')
    parser.add_argument('-s', action='store', dest='startValue', help="start value", default=1)
    parser.add_argument('-e', action='store', dest='endValue', help="end value", default=10)
    parser.add_argument('-i', action='store', dest='deltaValue', help="value increment", default=1)
    parser.add_argument('-p', action='store', dest='pause', help="Gause time", default=0.5)
    parser.add_argument('-d', action='store', dest='down', help="Range down", default=0)


    args = parser.parse_args()
    if args.jsonfile is not None:
        jsonpath = args.jsonfile
    if args.deviceId is not None:
        deviceId = args.deviceId
    else:
        deviceId = None      
    config = AutomationConfig(jsonpath)
    
    start = int(args.startValue)
    stop = int(args.endValue)
    increment = int(args.deltaValue)
    if bool(args.down):
        start = int(args.endValue)
        stop = int(args.startValue)
        increment = -1 * int(args.increment)
    for v in range(start, stop, increment):
        print(f'Write data value {v} to Glasgow device {deviceId}')
        write_inst = writeDataThread(config, deviceId, v) 
        write_inst.Start()
        time.sleep(float(args.pause))

if __name__ == '__main__':
    asyncio.run(main())
    