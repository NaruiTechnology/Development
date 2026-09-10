# ADC evaluation — not a selected BOM

Native 16–24-bit converters can be used with dedicated ADC/DAC paths. Bit count
alone does not determine compatibility: input bandwidth, noise, latency, rate,
digital interface, voltage and front-end settling all matter. A 24-bit code word
does not establish 24 noise-free or accurate bits at the system input.

Two illustrative manufacturer examples, checked 2026-09-10:

| Device | Native resolution | Rated sample rate | Relevance |
| --- | --- | --- | --- |
| TI ADS9218 | 18 bits, two simultaneous channels | 10 MSPS/channel | Example of high-rate SAR acquisition; evaluate lane clocking and FPGA compatibility |
| ADI AD4030-24 | 24 bits, one channel | 2 MSPS | Example of precision SAR acquisition; cannot meet a 4 MSPS/channel requirement |

These are evidence of available architecture tradeoffs, not drop-in replacements
or an exhaustive shortlist. No purchase or footprint selection is implied.
The AD4030-24 uses Flexi-SPI with 1/2/4 output lanes and 1.2–1.8 V interface
logic; direct connection to an assumed 3.3 V interface is not acceptable.
Its published typical SNR is 108.4 dB, demonstrating why native code width must
not be equated with 24-bit usable dynamic performance.

## Selection criteria

- Confirm raw conversions/second and channels separately from output pixels/second.
- Specify effective noise, dynamic range, linearity and absolute accuracy at the
  required bandwidth and rate; assess reference, driver and PCB noise together.
- Prefer a well-defined aperture and latency for scan association. Evaluate SAR,
  pipeline and filtered architectures against their actual timing behavior.
- Budget clock jitter, input acquisition settling, digital capture margin and
  any filter latency using the selected part's conditions.
- Make coding, overrange and startup behavior explicit and testable.

## Payload estimates

At 4 MSPS for one channel, data-only traffic is 8 MB/s for 16-bit words,
12 MB/s for packed 24-bit words, or 16 MB/s for 32-bit storage. At 2 MSPS,
32-bit storage needs 8 MB/s. Add headers, status, tags where transmitted,
DAC commands and transport overhead; multiply by channel count.
A one-lane 24-bit serial stream at 4 MSPS requires at least 96 Mbit/s before
framing and idle time. Do not assume the existing 48 MHz FPGA clock can serve
it without a deliberately designed faster or multilane interface.

Sources:
- [TI ADS9218](https://www.ti.com/product/ADS9218)
- [ADI AD4030-24](https://www.analog.com/en/products/ad4030-24.html)
- [ADI AD4030-24 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/ad4030-24.pdf)
