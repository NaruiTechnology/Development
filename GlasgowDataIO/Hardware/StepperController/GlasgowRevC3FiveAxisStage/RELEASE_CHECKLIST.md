# Manufacturing release checklist

Every checkbox is mandatory unless a written, reviewed waiver is attached.

## Selections

- [ ] X/Y/Z/T/R actuator and drive part numbers approved
- [ ] Encoder type, supply, protocol, and termination approved per axis
- [ ] Command protocol, voltage, timing, and polarity approved per axis
- [ ] Field supply voltage/current and protection coordination approved
- [ ] Connector families, keying, pin numbering, and cable drawings approved
- [ ] Regulatory target, safety category/PL/SIL, and environment defined
- [ ] Mechanical outline, mounting, keep-outs, and enclosure approved

## Engineering verification

- [ ] Independent safety architecture reviewed by a qualified safety engineer
- [ ] Isolation working voltage, creepage, and clearance calculations approved
- [ ] Input/output fault-state analysis complete
- [ ] Current-density, power, and thermal calculations complete
- [ ] EMC, shield, chassis, and grounding plan approved
- [ ] FMEA complete with no unacceptable open risk

## CAD and outputs

- [ ] Schematic peer reviewed
- [ ] ERC has zero unresolved errors
- [ ] PCB layout peer reviewed against drive reference layouts
- [ ] DRC has zero unresolved errors
- [ ] BOM contains orderable MPNs and approved alternates
- [ ] Gerbers and drill files independently viewed
- [ ] IPC-356 netlist compared with CAD netlist
- [ ] Placement file, assembly drawings, and polarity marks checked
- [ ] Stack-up and fabrication notes approved by the selected fabricator
- [ ] STEP model checked against enclosure and cables

## Prototype qualification

- [ ] Unpowered continuity/isolation inspection passed
- [ ] Current-limited power-up passed for every isolated domain
- [ ] Fail-disabled behavior verified for power loss and cable disconnects
- [ ] E-stop/STO response verified independently of software
- [ ] Limit/home/fault injection tests passed
- [ ] Motion range, repeatability, and encoder plausibility tests passed
- [ ] Z/tilt collision envelope tests passed
- [ ] Vacuum, temperature, and EMC tests passed for the intended environment

Release owner: ____________________  Date: __________  Revision: __________
