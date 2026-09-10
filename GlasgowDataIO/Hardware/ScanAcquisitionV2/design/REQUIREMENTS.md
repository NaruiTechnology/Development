# Requirements — draft

## Established direction

1. Separate acquisition input from scan output electrically and logically.
2. Evaluate actual converter resolutions of 16, 18, 20 and 24 bits. Output word
   width and effective measurement resolution are separate requirements.
3. Support deterministic association of detector intensity samples with XY
   commands in raster and vector modes, including dwell averaging and stalls.
4. Retain diagnostic access to raw conversion words, coding, overrange, lost
   samples, conversion sequence and acquisition timing.

## Provisional assumptions and open decisions

| Topic | Working assumption | Decision needed |
| --- | --- | --- |
| Detector channels | One intensity channel | Channel count; whether XY position-feedback ADC channels are also needed |
| Raw acquisition rate | 4 MSPS, matching the current nominal conversion rate | Required sustained/minimum rate and range of pixel dwell times |
| XY updates | Two axes, synchronized updates | Maximum update rate, resolution, settling and simultaneous-update skew |
| ADC resolution | Evaluate native 16–24-bit devices | Required input-referred noise, dynamic range, bandwidth and accuracy |
| Controller | Compare existing Glasgow revC3 with a new carrier/local FPGA | Whether Glasgow compatibility is mandatory |
| Digital link | Dedicated directions; parallel or serial not yet chosen | Lane count, clocking, pin budget and timing closure |
| Detector input | Unspecified | Range, polarity, differential/single-ended, impedance, overload, bandwidth |
| XY analog output | Unspecified | Voltage range, polarity, load/cable, bandwidth, accuracy and settling tolerance |
| Supplies | Unspecified; do not inherit the old rails | Available rails, current budget, sequencing and reference requirements |
| Mechanics | Unspecified; no inherited board outline | Mounting, enclosure, connector positions, cable length |
| Blanking and reset | Defined behavior required | Electrical levels and agreed idle/reset/disconnect output states |
| Retention | Preserve native raw samples and metadata | Recording format and sustained transport rate |

A higher ADC bit count improves possible intensity resolution, not the DAC's
spatial address resolution. The existing XY commands use 14-bit coordinates;
changing the DAC resolution is an independent interface/calibration decision.
If actual XY position feedback is requested, allocate separate ADC channels and
specify their simultaneity with the detector channel.

No unspecified analog voltage, connector or part is a design commitment.
Requirements can be refined while the reference packages remain archived.
