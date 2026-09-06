# Manufacturing manifest

This directory contains the connector STEP models used by the board source. Manufacturing exports are intentionally withheld until KiCad 9 DRC/ERC can be run against the revised KiCad 9 board; see `../RELEASE_STATUS.md`.

Required exports at release:

- Gerber copper, solder mask, paste, silkscreen, and Edge.Cuts
- Excellon drill file
- Pick-and-place position file
- Board STEP
- IPC-2581 or equivalent fabrication database
