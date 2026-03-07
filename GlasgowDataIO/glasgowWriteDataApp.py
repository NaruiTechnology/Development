import os
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from workthreads.writeDataThread import writeDataThread
import time, asyncio

async def main():
    import argparse
    parser = argparse.ArgumentParser(description='Load FPGA image onto the device.')
    parser.add_argument('-j', action='store', dest='jsonfile', help="Config Json file path", default=os.path.realpath(r'./Development/GlasgowDataIO/Json/default.json'))
    parser.add_argument('-g', action='store', dest='deviceId', help="Glasgow device Id", default='C3-20251207T145552Z')
    parser.add_argument('-s', action='store', dest='startValue', help="start value", default=1)
    parser.add_argument('-e', action='store', dest='endValue', help="end value", default=10)
    parser.add_argument('-i', action='store', dest='increment', help="value increment", default=1)
    parser.add_argument('-p', action='store', dest='pause', help="Gause time", default=0.5)
    parser.add_argument('-o', action='store', dest='port', help="Glasgow port [A,B]", default='A')

   
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
    increment = int(args.increment)
    
    direction = -1
    if start <= stop:
        direction = 1

    if start != stop:
        if direction > 0:
            stop += 1
        else:
            if stop >= 0:
                stop -= 1              
        increment = direction * int(args.increment)
        rg = range(start, stop, increment)
        print(rg)
        if abs(increment) > abs(start) and  abs(increment) > abs(stop):
            raise ValueError(f'The increment value [{increment}] is invalid!')
        for v in rg:
            writeOutData(deviceId, config, v)
            time.sleep(float(args.pause))
    else:
        writeOutData(deviceId, config, start)

def writeOutData(deviceId, config, v):
    print(f'Write data value {v} to Glasgow device {deviceId}')
    write_inst = writeDataThread(config, deviceId, v) 
    write_inst.Start()

if __name__ == '__main__':
    asyncio.run(main())
    