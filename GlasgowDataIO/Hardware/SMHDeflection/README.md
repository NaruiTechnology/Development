# Glasgow replacement for the SMH deflection command source

Retain the SMH high-voltage amplifier, electrode harness, column corrections and hardware blanking. Replace the legacy X/Y command source with Glasgow revC3 and the OBI-compatible ADC/DAC board. Feed the two DACs into the existing X/Y separator if its input is accessible and electrically compatible. Otherwise, add a low-voltage X/Y-to-four-pair adapter upstream of SMH J18. Use the installed equipment to qualify the adapter and column interface before releasing a cable drawing.

## Glasgow and FPGA channel inventory

The repository scan profile assigns A0 to scan enable, A2 inverted and A3 non-inverted to blank, and A4 to blank enable. A1 and A5 are released from the legacy duplicated-enable map. **A1, A5, A6, A7 and B0–B7** are unassigned as beam GPIOs. The optional correction DAC pin plan lists B0–B3. The sample-stage draft assigns A6/A7 to stage SPI on logical Device1. Verify the physical serials and carrier routing before calling those pins available on Device0. Vacuum A/B names in the current vacuum configuration refer to Raspberry Pi GPIO, and the GPIOs exposed on the OBI interconnect still depend on the installed board and harness. [Source scan JSON](../../Json/streamData.json) · [Stage JSON](../../Json/sampleStageSystem.json) · [Glasgow revC3 connector documentation](https://glasgow-embedded.org/en/revisions/revC3.html)

| Port signals | Physical contacts and FPGA balls | Source scan status |
| --- | --- | --- |
| A0–A5 | Port A contacts 3, 5, 7, 9, 11, 13. Balls A1, A2, B3, A3, B6, A4 respectively | A0, A2, A3 and A4 assigned. A1 and A5 available |
| A6/A7 | Port A contacts 15/17. Balls B7/A5 | Unassigned |
| B0–B7 | Port B contacts 3, 5, 7, 9, 11, 13, 15, 17. Balls B11, C11, D10, D11, E10, E11, F11, F10 respectively | Unassigned |
| SYNC | Separate two-pin connector, FPGA A11 | Unassigned by scan, outside the supported JSON beam-pin interface |

Port B GPIO B2 is a logical port label for FPGA ball D10. The raw FPGA ball B2 carries OBI bus bit 0 through Glasgow expansion J5 contact 41. A/B switches operate on translated GPIO. Expansion J5 is a direct connection to the FPGA and requires VIO_AUX at contact 44. The present bus is constrained for 3.3 V. A/B's JSON voltage controls the translated port rails. Match the expansion supply to the converter board design and verify power and returns before connecting the expansion cable. [Vendored platform](../../IobeamControl/glasgowLib/glasgow/hardware/platform/rev_c.py) · [Glasgow revC3 connector documentation](https://glasgow-embedded.org/en/revisions/revC3.html)

### Existing Glasgow expansion to OBI interconnect

The pinned upstream resource declaration and local JSON agree on all 21 signals. Use a revision-matched interconnect and verify contact 1 and cable orientation. In this table J5 is Glasgow's expansion connector. The target references are on the OBI revA4 converter as connected via the revA3 data interconnect.

| Local resource | FPGA ball(s) in listed order | Glasgow J5 contacts in listed order | OBI converter contacts | Direction at FPGA |
| --- | --- | --- | --- | --- |
| DATA[0:7] | B2 C4 B1 C3 C2 C1 D3 D1 | 41, 40, 39, 38, 35, 33, 34, 29 | J3 3, 5, 7, 9, 11, 13, 15, 17 | Bidirectional |
| DATA[8:13] | F4 G2 E3 F1 E2 F2 | 22, 17, 26, 21, 28, 23 | J4 3, 5, 7, 9, 11, 13 | Bidirectional |
| power_good | K1 | 3 | J2 3 | Input, status only |
| dac_x_le_clk | H3 | 14 | J2 7 | Output |
| dac_y_le_clk | H1 | 9 | J2 9 | Output |
| adc_oe | G3 | 16 | J2 11 | Output, inverted |
| adc_le_clk | H2 | 11 | J2 13 | Output |
| dac_clk | F3 | 20 | J2 15 | Output, inverted |
| adc_clk | G1 | 15 | J2 17 | Output, inverted |

Five direct FPGA contacts remain unassigned by the scan resources. They are Glasgow J5 contact 5 (J1/BGA, D18), 8 (K2), 10 (J2/BGA), 27 (E1) and 32 (D2). Some terminate at unused positions or routes on the OBI board. Verify end-to-end continuity and carrier sharing before reuse. These contacts provide digital I/O. The subtarget's physical build checks the fixed OBI pin contract, and its executor drives X and Y latches only. Extra DAC channels would need revised hardware, subtarget logic and timing verification. At the current timings the bus runs a six-clock cycle at 48 MHz, with an X latch followed by a Y latch two FPGA clocks later. The nominal conversion cycle is 125 ns. Account for that X/Y skew and downstream settling when measuring four-pair waveforms. [Pinned OBI resource source](https://github.com/nanographs/Open-Beam-Interface/blob/0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f/software/obi/applet/open_beam_interface/__init__.py) · [OBI KiCad files](https://github.com/nanographs/Open-Beam-Interface/tree/0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f/Hardware/PCBs) · [Local timing](../../IobeamControl/applet/OBI_TIMING.md)

## Low-voltage cable schedule

The OBI revA4 PCB routes DAC X to M8 J7 contacts **2 (+) and 1 (−)**, DAC Y to **3 (+) and 4 (−)**, and shell to GNDA. Alternatively the revA4 single-ended scan outputs are BNC J5 for X and J6 for Y. Confirm the installed OBI revision and verify X and Y with one-axis ramps into a test load. Feed both axes into the qualified separator or adapter input. A selector or relay interface should keep internal and external sources mutually exclusive, with break-before-make switching, and restore OEM or the equipment-approved safe state on loss of adapter control. [OBI board files](https://github.com/nanographs/Open-Beam-Interface/tree/0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f/Hardware/PCBs) · [OBI scan-selector design](https://nanographs.github.io/Open-Beam-Interface/hardware/accessory/generic_selector.html)

| Proposed cable circuit | Source end | Target end |
| --- | --- | --- |
| X command | OBI revA4 J7-2/1 (+/−) | Qualified separator or adapter X differential input |
| Y command | OBI revA4 J7-3/4 (+/−) | Qualified separator or adapter Y differential input |
| AE | Qualified adapter AE+/− differential output | SMH J18-1/9 |
| BF | Qualified adapter BF+/− differential output | SMH J18-2/10 |
| CG | Qualified adapter CG+/− differential output | SMH J18-14/7 |
| OH, as labelled on the input sheet | Qualified adapter OH+/− differential output | SMH J18-25/8. Verify whether OH denotes the D–H output channel |
| Detector, where required | Installed detector/video conditioning output | OBI ADC input within its measured range. OBI revA4 J8 is the external BNC ADC input |

Route each analog differential signal on its own shielded twisted pair. Establish receiver common-mode range, return and shield termination from the OEM grounding design. The SMH sheet identifies colgnd at J7-5/24, 12/31 and 17/36. Confirm its relationship to chassis, supply return and OBI GNDA before adding a bond. Match input load and source impedance to the original driver. The J18 signal sheet gives no confirmed input sensitivity, impedance, common-mode or per-gain transfer matrix. J18-12/13 reach an op-amp input on the redraw and require board-level identification before assignment. Connector designators repeat across boards. Use the connector shell markings and mating-face orientation in the release drawing.

### Digital control and SMH J5

The approved Port A harness design uses a new buffered control adapter. The adapter interprets two single-ended selector requests and a complementary blank command. The scan profile releases the former duplicate enable pins A1/A5. Use adjacent ground contacts as returns on the Glasgow side. The adapter provides hardware default blanking and valid receiver signaling independent of USB and FPGA state.

| Role | Candidate Glasgow Port A contact / adjacent return | Adapter behavior |
| --- | --- | --- |
| scan_enable | A0 at 3 / 4 | Request external scan takeover when high |
| blank_enable | A4 at 11 / 12 | Request external blanking control when high |
| blank inverted leg | A2 at 7 / 8 | Low on logical blank |
| blank non-inverted leg | A3 at 9 / 10 | High on logical blank |

The SMH sheet identifies J5-1/6 as BNK0VRWRT ±, J5-2/7 as BNKSEL ±, J5-3/8 as BEAMBNK ±, J5-4/9 as PATTCTRL ±, and J5-5 as NC. Preserve the OEM J5 circuit for initial scan-only integration. If Glasgow must take over blanking, the adapter's qualified line driver can hand off BEAMBNK at 3/8 after verifying receiver standard, termination, common mode, polarity and both paired-leg levels in OEM blanked and scanning states. Determine the remaining three pairs' timing and truth table on the installed instrument before assigning a selector or replacement driver. The attachment redraw describes H/L columns but supplies no per-pair state table. A2/A3 are complementary 3.3 V GPIO legs at the proposed adapter inputs. The adapter must generate the electrical interface that the SMH actually accepts. Preserve native blank priority. Require a hardware inhibit on reset, power loss, invalid complementary state and control loss. The software blank-on-release and 100 ms stall timeout supplement that inhibit. The current gateware drives both enable roles from the same external-control request. Its 20 ms switch delay must cover the actual selector timing. On startup Glasgow requests low pulls on A0, A2 and A4 and a high pull on A3 before activating the interface. These levels deassert both selector requests and assert blank. The hardware permit still governs takeover independently.

## Eight-pole and dual-deflector functions

The supply designs define two scan commands plus position offsets and astigmatism correction. With x = Vx + Vox, y = Vy + Voy and a = 0.414, the four opposite pairs in the supply documents have these plate-voltage targets. The row numbers are the supply diagram's electrode order. Establish the row-to-SMH-plate correspondence by continuity and measured sign.

| Supply diagram rows | First plate minus opposite plate | Pair average |
| --- | --- | --- |
| 1 / 5 | −2x + 2ay | Va |
| 2 / 6 | −2ax + 2y | Vb |
| 3 / 7 | 2ax + 2y | −Va |
| 4 / 8 | 2x + 2ay | −Vb |

The document scales the first deflector's plate targets by k and names the second deflector as master. The pair-average terms show why four differential scan commands alone cannot be assumed to reproduce independent astigmatism. J18 has four differential inputs, while J7 exposes one A–H plate set plus four named scan-output pairs. The X1/Y1/X2/Y2 names do not establish a master/slave electrode mapping. Preserve legacy steering, offsets and stigmation through the installed separator/controller or J17 paths pending transfer measurement. If those functions must also be replaced, trace the column topology first, then provide independently controllable correction paths and a qualified path to the second deflector. The two-DAC gateware can still source X and Y if a downstream circuit performs the mixing and calibrated scaling. Pixel-dependent independent correction requires additional synchronized analog channels and associated control logic.

The alternative adapter uses two differential receivers for X/Y, a calibrated 4×2 analog matrix with offsets, and four differential line drivers. Measure the existing source-to-J18 transfer at a fixed, verified gain/filter setting. Fit each output differential as gX·X + gY·Y + offset. Set each driver's common mode from the OEM input requirements. Repeat at other necessary settings and preserve the existing J1 configuration until its bus levels, bit coding and latch behavior are known. Treat the table above as electrode-domain targets. Relate them to the adapter through the measured J18-to-J7 gain, polarity and cross-coupling. On the SMH sheet the plate pairs at J7 are A/E 1/20, B/F 2/21, C/G 33/15 and D/H 34/16. Preserve J7, J4, J8 and J9 on the OEM harness. The 200 V figure in the supply diagrams is a legacy generator limit. The SMH redraw identifies ±150 V rails and high-voltage outputs. Set command clamps from measured input range and output headroom at the required gain, offset, correction and k.

## Commissioning and release

1. Record Glasgow serial, carrier and OBI revision, SMH assembly revision, connector mating-face numbering, and OEM mode/gain. With the equipment in its service-safe state, trace both deflectors, the separator, all J18 returns, J17 correction paths, and actual J5 routing. Obtain EM20810 and associated circuit sheets if available. The HTML is a redraw of a signals sheet.
2. Capture the original generator and SMH input behavior with the beam inhibited under the equipment's approved service procedure. Measure each J18 pair's differential swing, common mode and polarity, plus J5 leg voltages and relative timing across internal/external, blanked/scanning and fault transitions. Capture X-only, Y-only and correction-only perturbations and identify gain and sign for each active plate and both deflectors.
3. Validate the proposed adapter off the column with representative loads. Check small ramps, midpoint/offset, full specified range, clipping, settling, X/Y update skew, crosstalk, mode switch timing and safe behavior for USB loss, FPGA reset, adapter power loss, invalid blank pairs and stalled scan. Use equipment-approved procedures and instruments for any high-voltage checks.
4. Install the low-voltage interposer with an OEM bypass. Verify fail-safe blanking and correct hand-back before releasing the beam. Commission at low deflection and a fixed gain, then calibrate axis orientation, field size, offset, stigmation and tracking across both deflectors. Approve the measured transfer matrix, J5 truth table, connector schedule and rollback to OEM before enabling normal scans.

## Repository profiles and takeover lock

The [commissioning profile](streamData.smh-commissioning.json) selects physical ADC/DAC I/O. The repository’s [active profile](../../Json/streamData.json) selects simulation with image generation disabled, which uses coordinate loopback. The factory-reset profile also selects simulation. All three share the SMH pin roles, mixer coefficient, correction-DAC pin plan and FPGA takeover lock.

The root-level `IsProduction` setting controls the SMH selector handoff for both raster and vector scans. It defaults to `true`, which leaves the selector outputs inactive. Set it to `false` to let scan commands request external control of the eight-pole deflection path. Verify the analog transfer, selector wiring and hardware blanking under the approved commissioning procedure before enabling this mode. The hardware permit remains necessary to cover periods when the FPGA or port power is unavailable.

The applet checks the SMH coefficient and verifies that the planned correction pins are distinct from each other and from assigned beam pins. The plan reserves no gateware I/O. The selected DAC, control protocol, and analog interface are needed before adding physical correction outputs.

From the repository’s Development directory, calculate the report example without a device connection.

```sh
python -m GlasgowDataIO.IobeamControl.smhDeflection --config GlasgowDataIO/Json/streamData.json \
  --vx 20 --vy -10 --vox 3 --voy -4 --va 2 --vb -1 --slave-scale 0.60
```

Values are plate targets in volts, ordered 1 through 8. For a single deflector, omit the slave scale. Use the measured signed scale for an installed second deflector.

For each bench vector, pass a measured plate set with `--measured-master` or `--measured-slave` followed by eight voltages in electrode order. Supply the equipment’s acceptance tolerance with `--tolerance` in volts. The report contains signed plate errors, pair-average and half-difference errors, and the maximum absolute plate error. Exit status is 1 for a valid measurement outside tolerance and 2 for invalid inputs. A signed slave scale is required for a slave comparison. The example below uses an illustrative 0.1 V tolerance and ideal measurements.

```sh
python -m GlasgowDataIO.IobeamControl.smhDeflection --config GlasgowDataIO/Json/streamData.json \
  --vx 1 --vy 0 --tolerance 0.1 \
  --measured-master -1 -0.414 0.414 1 1 0.414 -0.414 -1
```

See the [HTML design report](glasgow-eight-pole-design.html) for the complete electrode matrix, connector schedule and bench acceptance sequence.

Source attachments were used as engineering reference material. The plate equations and relative scaling come from the PowerPoint slide and Word figures. The SMH connector labels come from the EM20810 redraw.
