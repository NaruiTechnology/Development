import os
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from GlasgowDataIO.workthreads.streamDataThread import streamDataThread
import asyncio
from IobeamControl.transfer.glasgowStream import GlasgowConnection

async def main(config, deviceId, waveForm, data, conn): 
    if conn is not None and conn.connected: # TODO ------
        conn = None
    #----------------------------------------------- TODO
    sream_inst = streamDataThread(config, deviceId, waveForm, data, conn) 
    sream_inst.Start()

async def connect(conn):
    await conn._connect()

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
    data = None
    if args.data is not None:
        print(f'Input data = {args.data}')
        #data = [int(x) for x in args.data.split(",")]
        data = [x for x in args.data.split(",")]
        print(f'---------------------------------\n') 
        print(data) 
       
    config = AutomationConfig(jsonpath)
    conn = GlasgowConnection(config)

    asyncio.run(connect(conn))
    asyncio.run(main(config, deviceId, args.waveForm, data, conn))