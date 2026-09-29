import math
import csv
from pathlib import Path

def main(filePath = None, waveForm = None): #, waveform_type="sine", points=1000, resolution=12, cycles=10):
    import argparse
    parser = argparse.ArgumentParser(description='Generate a large csv data source file.')
    parser.add_argument('-f', action='store', dest='fileName', help="filename: Path to save the CSV.", default=r'./unittest/testData/WaveformData.csv')
    parser.add_argument('-p', action='store', dest='points', help="Total number of data points to generate.", default=1000)
    parser.add_argument('-w', action='store', dest='waveForm', help="waveform_type: sine, square, or triangle.", default=r'sine')
    parser.add_argument('-g', action='store', dest='deviceId', help="Glasgow device Id", default=None)
    parser.add_argument('-r', action='store', dest='resolution', help="DAC resolution (e.g., 8, 12, or 16)", default=12)
    parser.add_argument('-c', action='store', dest='cycles', help="Number of wave cycles to complete within the total point count.", default=10)
    args = parser.parse_args()

    fileName = filePath
    if filePath is None:
        fileName = args.fileName
    waveform = waveForm
    if waveform is None:
        waveform = args.waveForm

    max_val = (2**args.resolution) - 1
    period = args.points / args.cycles # points per single cycle
    
    data = []
    for i in range(args.points):
        # Normalized time within one cycle [0, 1)
        t = (i % period) / period  
        
        if waveform == "sine":
            val = int((math.sin(2 * math.pi * t) + 1) * (max_val / 2))
        elif waveform == "square":
            val = max_val if t < 0.5 else 0
        elif waveform == "triangle":
            val = int(max_val * (1 - abs(2 * t - 1)))
        else:
            raise ValueError(f"Unknown waveform type: {waveform}")
            
        data.append(val)
    try:
        path = p = Path(fileName)
        if p.parts[0] == 'unittest':
            path = f'{p.cwd()}/Development/GlasgowDataIO/IobeamControl/{str(p).replace(p.name, "")}'
        fileName = f'{path}{p.name.replace(".csv", "")}_{waveform}.csv'
        if not Path(path).is_dir():
            Path(path).mkdir(parents=True, exist_ok=False)
        with open(fileName, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(data)
        print(f'Generate [(fileName)], point = {args.points}, resolution = {args.resolution}_bit, cycles = {args.cycles}, successfully.')
    except Exception as e:
        print(f'Failed to generate data, error was: {e}.')   
        exit(1)         

if __name__ == "__main__":
    main()