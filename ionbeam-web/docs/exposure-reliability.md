# Exposure lattice reliability audit — 2026-11-11

Scope: browser exposure scheduling and transport, Node authorization/proxy,
Glasgow lattice generation and vector sender completion. This audit uses
hardware-free tests; it does not establish measured dose or hardware endurance.

## Findings and changes

| Failure path | Change |
| --- | --- |
| Every small lattice segment opens another authenticated browser connection, exposing a long recipe to repeated account lookups and token expiry. | Updated backends advertise `exposure_session_stream`. `/ws/exposure/session` authorizes once, then forwards strictly serial finite lattice and View requests. Each upstream acquisition remains separate. The browser closes the channel at the end of the run. New runs still require current authorization. Older and Node mock backends retain the original endpoints. |
| The explicit defaults metadata route was registered after the catch-all proxy, so its augmentation/fallback could not run. | Register defaults before the catch-all and verify capability discovery against an isolated real backend, not only a mocked store. |
| A failed account DB lookup can become `registered:false`, making App delete a valid stored identity. | If neither the DB nor the local configuration can resolve an identity during a DB outage, return HTTP 503. Do not assert that the account disappeared. Confirmed missing, inactive and expired accounts remain rejected. |
| Fixed 30-second sample watchdog ignores dwell/buffering; waiting for WebSocket close can strand completion or errors. | Allow service startup plus a dwell/buffer allowance. Settle on explicit `done` or error; validate binary frame alignment and full View frame length. Use browser-valid close codes. Neither errors nor completion depend on a peer's close event. |
| A reachable proxy can conceal a stalled acquisition; a paused browser can miss a dead connection. | Server heartbeat and ping/pong detect transport loss, including while paused. The browser separately times acquisition progress; heartbeat messages do not reset that deadline. A lost persistent session wakes a paused recipe so it fails rather than hanging. |
| HTTP account/capability preparation and Stop can wait indefinitely. | Bound account/capability responses and JSON bodies to 15 seconds; legacy abort to 5 seconds. View asset uploads receive a per-request deadline and cancellation signal. Timeouts retain the saved sign-in. |
| Global Stop can affect another operator while this recipe is paused. | Persistent-session Stop closes its own channel and upstream connection. The service's owner-specific disconnect watcher aborts that stream. The legacy path sends global abort only with an active request. |
| A lost stream leaves ambiguity about which spots received dose. | Fail the session; never reconnect, retry or replay a segment automatically. Earlier completed steps and received sample counts remain available. Start is a new run, not an exact-position resume. |
| Sender drain timeout is ineffective if the receiver waits for the sender's sentinel after the stuck drain flush. | Queue the sentinel after the real data, before padding. The receiver finishes real samples and the bounded sender drain wait can execute. Reap the sender even if synchronization fails. |
| Sender/drain errors can be logged and suppressed, allowing a false `done`. | Lattice commands require successful sender completion. Drain timeout and USB sender errors propagate through the service as failures. Other vector command callers retain their existing completion policy. |
| Drain padding can run unblanked if frame blanking is disabled. | Lattice commands explicitly blank before drain padding. |
| Merging sub-DAC spots silently clamps accumulated dwell to 16 bits. | Preserve excess dose as additional points at the same coordinate, in both Python generation and the TypeScript helper. Every command stays within 16 bits and summed conversions remain exact. |

## Deployment

Run both web production builds and regenerate the compiled distribution with
`Development/buildCompiledDist.py`. It checks the three new web runtime modules
and verifies the distribution manifest/hashes. The same archive includes the
updated service and vector macro. No database schema changes or new dependencies
are required. Existing nginx `/ws/` routing covers the session endpoint; periodic
heartbeat traffic prevents its idle read timeout during an active session.

Running services are not restarted by the audit. Activate these components
together during an idle maintenance period. A browser with old cached defaults
may use the legacy endpoints until defaults refresh; a reload obtains the new
session capability. The Node mock backend deliberately retains legacy streams.

## Verification and limits

Regression coverage includes session reuse across segments/passes/View, identity
storage outages, no replay after disconnect, incomplete/invalid frames, missing
close events, independent transport/acquisition deadlines, Stop before connection,
paused transport loss, sender drain and USB/sync failures, beam blanking before
padding, exact high-dwell charge, and cross-language lattice golden fixtures.

Physical validation still requires the actual instrument: a sustained run with
representative rings/polygons, high dwell, multiple passes, View, pause/resume,
and deliberate cable/service loss. Verify blanking and delivered charge with
instrumentation. Browser/process restart does not resume a partly exposed
pattern. Per-card beam current remains a planning input; the application does
not set or measure instrument current. Timeout allowances include the configured
revC3 ADC half-period, dwell and a conservative buffering margin; hardware stalls
still terminate the run and require operator review.

Validation results: all 36 lattice/service tests, five existing vector mock tests,
63 distribution integrity/deployment tests, and focused browser/proxy exposure
tests passed. Both production web builds passed. The compiled handoff manifest
was verified and its web sources and Python code compared with the working tree.
The broader frontend run retains six failures, all also present in an unchanged
HEAD checkout (which had eight failures). The backend gray-range stream failure
also reproduces on unchanged HEAD. These unrelated failures are not reported as
passing checks. Sandbox socket restrictions stalled some asynchronous tests;
the relevant hardware-free checks passed with normal local runtime access.
