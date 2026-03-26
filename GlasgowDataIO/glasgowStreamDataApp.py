import os
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from GlasgowDataIO.workthreads.streamDataThread import streamDataThread
import asyncio

async def main(config, deviceId, waveForm, data, conn): 
    sream_inst = streamDataThread(config, deviceId, waveForm, data, conn) 
    sream_inst.Start()

async def run_pipeline(config, deviceId, waveForm, data, conn):
    if conn is not None:
        await conn._connect()
    await main(config, deviceId, waveForm, data, conn)    

if __name__ == '__main__':
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
       
    config = AutomationConfig(jsonpath)
    conn = None # TODO: GlasgowConnection(config)
    asyncio.run(run_pipeline(config, args.deviceId, args.waveForm, args.data, conn))