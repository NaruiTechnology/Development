# OBI comparison: ADC collection and serialization

Reference: local `/home/vboxuser/Project/Open-Beam-Interface`, commit
`0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f`.
[Upstream source](https://github.com/nanographs/Open-Beam-Interface/blob/0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f/software/obi/applet/open_beam_interface/__init__.py).
The comparison used the local gateware source; web retrieval was unavailable.
Existing local modifications to upstream frame_buffer.py and its test were not used.

## Findings

The bidirectional data buffer already exists in
`GlasgowDataIO/IobeamControl/applet/iobeamDataSubtarget.py`:

```python
self.data = platform.request("data", dir="-")
m.submodules.data_buffer = data_buf = io.Buffer("io", self.data)
m.d.comb += [
    data_buf.o.eq(executor.bus.data_o),
    data_buf.oe.eq(executor.bus.data_oe),
]
```

It is the equivalent of OBI's `data = io.Buffer("io", self.data)` at line 456.
The local input connection is `executor.bus.data_i.eq(Cat(data_buf.i, Const(0, 2)))`.
Amaranth Cat places its first argument in the least significant bits, so this
zero-extends a 14-bit sample; it does not shift it left. Buffer.i is combinational.
The local capture register lives in BusController's ADC_Capture state.

| Stage | Local implementation | OBI reference | Assessment |
| --- | --- | --- | --- |
| Physical data pins | streamData.json: B2 C4 B1 C3 C2 C1 D3 D1 F4 G2 E3 F1 E2 F2 | Same pin order | Matches |
| ADC OE pin | G3, inverted | a_enable G3, inverted | Matches configured polarity |
| Data buffer | io.Buffer("io"), bus.data_o and bus.data_oe | Same | Matches |
| Input width | Raw 14 bits zero-extended into a 16-bit bus | 14-bit bus | Same numeric ADC value |
| Acquisition | Explicit enable, settle, registered capture, read and bus turnaround states | ADC_Wait enables OE/LE, then ADC_Read forwards input | Different timing; not waveform equivalent |
| Conversion phase | LE after logical falling / physical rising clock | LE at logical high phase | Different; requires board timing validation |
| Averaging | Supersampler uses largest power-of-two prefix of dwell samples | Same algorithm | Matches algorithm; local sample width is 16 rather than 14 |
| Image word | Raw average, unshifted | Average shifted left by 2 | Does not match wire scaling |
| 16-bit serializer | High byte, then low byte | Same | Matches byte ordering/handshake |
| 8-bit serializer | Upper byte of raw 14-bit sample: 0..63 | Upper byte after << 2: 0..255 | Local mode loses two additional bits of precision |
| Host reader | array('H'), byteswap on little-endian hosts | Same conversion | Matches numeric decoding |
| WebSocket | Service re-encodes numeric samples as big-endian | Application-specific | Agrees with local browser decoder |
| Browser | Big-endian uint16; raw14 display full scale 0x3fff | Different application | Agrees with local 16-bit format |

Both VECTOR and RASTER converge on the same Supersampler, CommandExecutor image
stream, ImageSerializer and FIFO. Their coordinate/command producers differ.
Changing the scan serializer cannot change the physical ADC OE voltage.

Concrete wire examples (image samples, excluding synchronization):

| Raw ADC | Local 16-bit | OBI 16-bit | Local 8-bit | OBI 8-bit |
| --- | --- | --- | --- | --- |
| 0x0001 | 00 01 | 00 04 | 00 | 00 |
| 0x1234 | 12 34 | 48 d0 | 12 | 48 |
| 0x3fff | 3f ff | ff fc | 3f | ff |

The local EightBit browser decoder shifts the byte left by 8. This reconstructs
the coarse raw14 scale, but only six significant bits remain. Copying OBI's
left shift alone would make the current raw14 display clip values. A change to
OBI wire scaling must also update host/browser normalization, full-scale checks,
and the full16 simulation contract together. No wire-format migration was made
as part of this comparison.

## ADC TEST is a separate acquisition path

`AdcDataStreamApplet.py` uses `io.Buffer("i", data_port)` and a 14-bit input.
Its capture register zero-extends that value and its own serializer writes high
byte then low byte. It does not use the scan BusController, Supersampler or
ImageSerializer. It keeps logical adc_oe asserted during capture, whereas scans
time-share the data bus with DAC writes. Thus a fix to scan capture timing or
averaging does not automatically fix ADC TEST.

ADC TEST can drop acquisition points when USB backpressure outlasts its sample
buffer; scanning uses ready/valid flow control and buffering. They therefore
also differ in temporal sample selection under stalls. This is distinct from
byte order or ADC value alignment.

## Correction to the earlier OE diagnosis

The former `platform.request(..., dir="o")` control path was not missing an
output buffer. Installed Amaranth's build/res.py creates PinBuffer, whose
zero-XDR output path creates io.Buffer("o", port). Port inversion is retained.
The current explicit-buffer form resembles OBI, but that refactor alone does
not establish an electrical fix. Comments claiming otherwise were corrected.

The reported 0.1 V in ADC TEST versus 2.6 V in VECTOR remains unresolved by
this source comparison. Continuous versus pulsed OE could affect a DC-average
measurement; it cannot establish why an observed waveform fails to reach a
valid low. That requires measuring the physical low plateau and timing against
ADC clock, LE and DAC bus ownership on the loaded image. These simulations
cannot validate voltage, external pin connectivity, or ADC/board timing limits.

No missing buffer, byte swap, or post-averaging shift has been demonstrated as
the physical saturation root cause. A constant full-scale stream alone also
cannot uniquely prove that the subtarget is disconnected. A confirmed physical
preflight failure should be reported consistently across scan modes, but a
generic transport reset must not be treated as proof of missing ADC hardware.

## Validation and changes

Added `unittest/applet/test_physicalDataPath.py`: real production modules with
loopback disabled and SimulationPort at the pad boundary. The test injects
0, 1, 0x1234 and 0x3fff for VECTOR and RASTER in both output modes (16 cases).
It varies command arrival and FIFO readiness, drives poison data outside the
active-low ADC OE window, checks that FPGA data outputs are disabled in that
window, and checks exact synchronization and image bytes. It passes with the
raw14 contract and confirms the EightBit precision limitation.

This is digital simulation of the input-buffer-to-USB-FIFO path, not a physical
ADC model or a hardware test. Constant inputs exercise accumulation without
proving analog latency or changing-signal dwell alignment.

Corrected buffer/capture comments and the English, Simplified Chinese and
Traditional Chinese help text: the sample wire format is big-endian, not
little-endian. No new FPGA image was built or loaded during this comparison.
