import os

from AutomationPy.buildingblocks.automation_config import AutomationConfig
from workthreads.LoadFPGAThread import LoadFPGAThread

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Load FPGA image onto the device.')
    parser.add_argument('-j', action='store', dest='jsonfile', help="Config Json file path", default=None)
    #parser.add_argument('-l', action='store', dest='logname', help="Log file name", default='LoadFPGAImage')

    args = parser.parse_args()
    if args.jsonfile is not None:
        jsonpath = args.jsonfile
    else:
        jsonpath = os.path.realpath(r'Development/LoadFPGAImage/Json/LoadFPGAImage.json')
    config = AutomationConfig(jsonpath)
    thread = LoadFPGAThread(config)
    thread.Start()