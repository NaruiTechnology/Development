import os

from AutomationPy.buildingblocks.automation_config import AutomationConfig
from workthreads.LoadFPGAThread import LoadFPGAThread

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Load FPGA image onto the device.')
    parser.add_argument('-j', action='store', dest='jsonfile', help="Config Json file path", default=os.path.realpath(r'./Json/LoadFPGAImage.json'))
    parser.add_argument('-g', action='store', dest='deviceId', help="Glasgow device Id", default=None)

    args = parser.parse_args()
    if args.jsonfile is not None:
        jsonpath = args.jsonfile
    if args.deviceId is not None:
        deviceId = args.deviceId
    else:
        deviceId = None        
    config = AutomationConfig(jsonpath)
    thread = LoadFPGAThread(config, deviceId)
    thread.Start()