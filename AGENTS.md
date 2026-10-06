# AGENTS.md — Atmoce Homey app

Knowledge base for coding agents (and humans) working on this repo. Read it before
changing anything non-trivial; update it in the same commit when a pattern changes.

## 1. What this app does

Brings an Atmoce solar + battery system into Homey Pro, **locally**, over the gateway's
official Modbus TCP interface. No cloud, no reverse-engineered APIs.

```
Atmoce microinverters ─PLC─┐
Atmoce batteries ──────CAN─┤  M-Gateway MG100 (built into M-Combiner MC100 / MC100-T)
CT clamps (grid) ──────────┘        │ Wi-Fi or Ethernet, Modbus TCP server :502, unit 1
                                    ▼
                               Homey Pro
```

One gateway becomes up to three Homey devices (Homey Energy requires one device per
function):

| Driver | Class | Energy role | Source registers |
|---|---|---|---|
| `solar` | `solarpanel` | production (`meter_power`) | 60069, 60160, 60164, 60066 (fault → device warning + Flow cards) |
| `battery` | `battery` | `homeBattery`, imported = charged, exported = discharged | 60067–60071, 60095, 60166–60176, 60200–60202, control 60301–60317 |
| `grid` | `sensor` | `cumulative`, imported / exported | 60073, 60089–60094, 60178–60188 |

All Atmoce battery models (MS-7K-U, MS-8K-U / PRO, BattBank) talk CAN to the gateway and
are reported as **one aggregate** (summed capacity and power limits, one SOC). Capacity and
limits are read at runtime, so there is no model-specific code. Per-pack data is not
available locally.

**Not supported:** MC100L (Lite) — Atmoce says it has no third-party interface at all.
MC100PRO / CombinerX / MC100R are not listed in the spec (unknown). EV chargers speak
OCPP, not this interface.

## 2. Sources of truth

- `docs/Atmoce Gateway and SCU Modbus Protocol Interface V1.6.pdf` — **current official spec**
  (V1.6, 2026-04-18; published by Atmoce Deutschland in the Loxone library, plugin 1849,
  attachment 3137 — not linked on atmoce.com). Adds 60096/60098 (V1.5), 60310 modes
  4 = self-consumption / 99 = standby, 60311 modes 2/3, 60318–60326 (V1.3) and 60330/60332.
  Firmware gates in its notes: 60096/60098 ≥ 01.01.00.25, 60330/60332 ≥ .28,
  60318–60326 ≥ .29 (and only when 60301 = 1 or 60310 ≠ 2). Appendix 1: "The
  charging/discharging capability of the batteries can be confirmed through 60200 and 60202."
- `docs/Atmoce Gateway Modbus Protocol Interface V1.2.pdf` — previous public spec (2025-10-23).
  The PDF is image-only; render pages (`pdftoppm -r 110 -png`) to read it. Table 3.1
  "Serial Number" (#1–#54) is what comments in `lib/registers.mts` refer to.
- Atmoce-Cloud API Reference V1.2.5 — only used to confirm the battery power sign
  ("Positive number: battery being discharged").
- Homey SDK docs: https://apps.developer.homey.app/ (append `.md` to any page URL for Markdown).
  Energy page: https://apps.developer.homey.app/the-basics/devices/energy

## 3. Things that are NOT verified on hardware yet

Written against the spec and a simulator only. Check these on a real installation with
`tools/probe.mts` (read-only) before trusting them, and record the outcome here:

1. ✅ **Battery sign (60071)** — VERIFIED 2026-09-28 on an MC100 (hardware 4.0, firmware
   01.01.00.23.10, protocol register 60026 = 1.6, 2 × MS-7K-U): status 60067 = 1
   (charging) with 60071 = −4127 W. Positive = discharging; `batteryPowerForHomey`
   inverts it for Homey (+ charging).
2. ✅ **Grid sign (60073)** — VERIFIED 2026-09-28: 60073 = −2070 W while the Atmoce portal
   showed 2.14 kW "to grid" and the export counter rose. The portal's charts also label
   the official convention: "From Grid[+] / To Grid[−]", "Discharged[+] / Charged[−]".
   (Earlier note: no Atmoce document states it. Assumed positive = import, as
   evcc and the Home Assistant integration use. First hardware read was exactly 0 W
   (self-consumption balancing), so still open: run `tools/probe.mts <ip> --watch 120`
   while importing or exporting. In the same read phase A current (60090) was 3.05 A at
   0 W grid power — check whether 60089/60090 measure the grid point or the gateway output.
   The gateway reports protocol 1.6 while the public spec is V1.2: ask Atmoce for the
   current register map.)
3. **Is 60301 = 1 required for writes?** The spec implies dispatch #52 only acts in remote
   mode (#14 value 10 "Remote Communication Control"), so `setDispatchPower` writes
   60301 = 1 first. For forced charge/discharge (#47) the spec says nothing: evcc writes
   60310 without 60301, the HA integration says writes are ignored in local mode. The app
   currently does *not* touch 60301 for forced commands. Decide on hardware.
4b. **Does a forced run with a duration (60311 = 1) end by itself?** The spec does not say what
   the gateway does when 60313 runs out (back to 60310 = 2?). The app relies on it; not yet
   observed on hardware. TEMPO ROOD uses target SOC and stops explicitly at 06:00.
4. **Does the gateway time out remote control?** Unknown. If Homey dies without a clean
   `onUninit`, the battery could keep the last dispatch setpoint. On a clean stop the
   battery device hands control back (`handBackControl`).
5. ✅ **Multiple Modbus clients** — VERIFIED 2026-09-28: `tools/probe.mts` read the gateway
   while Homey was connected. Pairing still reuses the running connection.
6. **Menu path** "Settings → 3rd Party System" (from a HA forum thread) is used in UI texts.
7. **Registers 60318–60326** — present on firmware 01.01.00.23.10 too (all 0xFFFFFFFF =
   "no limit"), so evcc's ≥ 01.01.00.28.15 gate is stricter than needed. Still undocumented
   and write-side untested; not used. Originally: (charge/discharge caps, PV curtailment, export/import limits)
   are used by evcc on firmware ≥ 01.01.00.28.15 but are **not in the spec**. Deliberately
   not used. Ask Atmoce for a newer spec before adding curtailment.

### Register discovery (read-only sweep, 2026-09-28, MC100 fw 01.01.00.23.10)

`tools/probe.mts` style reads only; nothing undocumented was ever written.
- The gateway answers **only reads that cover whole values**: a 1-register read of a U32
  times out (no exception). Unknown addresses also time out rather than answering 0x02,
  but reserved rows read as 0 when a read overlaps a documented register.
- Undocumented but present: 60096 (U16, 0), 60098 (U16, 1), 60318/60320/60322/60324/60326
  (U32, 0xFFFFFFFF — evcc's charge cap, discharge cap, PV max, export max, import max),
  60330 (I32, 0x7FFFFFFF), 60332 (32-bit, 0). Nothing in 60500–60999.
- **No register holds the Atmozen charge/discharge limit** (portal: discharge 10 %,
  charge 100 %). No other integration (HA Atmoce_battery_HA, evcc, Node-RED, HA YAML)
  reads them over Modbus either; the HA integration uses the private portal API.
- **60200/60202 are live limits**, not ratings: 7350/6140 W at 45 % charging, 0/0 at 71 %
  during a pause, 7500/9940 W at 75 % charging. Hence: target_power range from 60029,
  and `LimitLearner` learns the Atmozen limits from a one-sided 0 (see below).

- 2026-09-28 experiment: the Atmozen discharge limit was changed 10 → 8 % and every readable
  register in 60000–60460 was re-read: none holds 8 / 80 / 800. The limits are not exposed
  over Modbus (also not in V1.6). 60098 tracked 60067 (1 → 2) on firmware .23.10, although
  V1.6 says ≥ .25. So the app detects this feature instead of trusting the version:
  `lib/feature-check.mts` enables 60096/60098 once 60098 has agreed with 60067 three times
  (≤ 10 % disagreement), or immediately on firmware ≥ .25. Write features (60318–60332)
  keep the spec's firmware gate: they cannot be probed without writing.

### Learned charge / discharge limits

`lib/limit-learner.mts`: when 60202 = 0 while 60200 > 0 and SOC < 50 (or the reverse and
50 < SOC < 100) for 6 polls, outside remote/forced control, that SOC is stored as the
Atmozen discharge (or charge) limit (device store `learnedLimits`, shown as read-only
settings). A different cut-off later replaces it. Assumption to VERIFY on the first evening
the battery reaches 10 %: 60202 drops to 0 at the discharge limit.

## 4. Architecture

```
app.mts                       App: owns the GatewayRegistry
lib/registers.mts             pure: register map, decoders, encoders, sign conventions
lib/modbus-connection.mts     one serialised Modbus TCP connection (modbus-serial)
lib/gateway.mts               AtmoceGateway: poll loop, identity check, control writes, events
lib/gateway-registry.mts      one AtmoceGateway per serial, ref-counted by devices; probe()
lib/atmoce-device.mts         base Device: attach/detach, availability, settings sync
lib/atmoce-driver.mts         base Driver: shared pairing (connect → list_devices → add_devices)
lib/derived.mts               pure: home consumption, self-sufficiency, stored energy, time to
                              full/empty, threshold crossing, Hysteresis (+ THRESHOLDS)
lib/limit-learner.mts         learns Atmozen charge/discharge limits from the live limits
lib/gateway-alerts.mts        connection lost (after 10 min) / restored, firmware updated — once per gateway
lib/format.mts                localised durations and times (Intl) for notifications and diagnostics
lib/errors.mts                WrongGatewayError
                              (registers.mts: FIRMWARE gates + firmwareAtLeast, spec V1.6)
drivers/{solar,battery,grid}/ driver.mts, device.mts, *.compose.json, assets/
.homeycompose/                app.json, capability, settings templates, pair template
tools/simulator.mts           simulated gateway (tests + manual testing)
tools/probe.mts               read-only diagnostic for a real gateway
test/                         node:test — decoders (unit) + gateway stack vs simulator
```

Key decisions:

- **Device data `id` = gateway serial** (register 60000), never the IP. The same serial is
  used by all three drivers (data is unique per driver).
- **One connection per gateway**, shared through the registry. Requests are serialised.
  Pairing and settings validation use `registry.probe()`, which reuses a live connection.
- **Poll** reads only documented blocks (reserved rows can answer "illegal address"):
  status 60066×13, phases 60089×7, energy 60160×30, limits 60200×4, control 60301×4,
  forced 60310×8. Identity 60000×33 is re-read after every reconnect (firmware updates,
  a different gateway on the same IP → `WrongGatewayError`, device unavailable).
- **Availability:** unavailable immediately when never reached, otherwise after 3
  consecutive failed polls (single Wi-Fi blips only log).
- **Core vs optional blocks:** status, phases and energy (spec V1.0) are required; limits,
  control, forced and grid state are optional — after 3 consecutive failures they are
  skipped for an hour (this gateway times out on unknown addresses instead of answering
  0x02), so older firmware never makes devices unavailable; features depending on them
  (limit learning, external-control sync, V1.5 cards) simply stay inactive.
- **Discovery** (`lib/discovery.mts`): pairing scans the /24 of `homey.cloud.getLocalAddress()`
  (private IPv4 only) for port 502, 32 hosts in parallel, 700 ms connect timeout, then reads
  the identity block. Gateways already in use answer from memory. VERIFIED 2026-09-28 on Homey Pro
  (13.5.0): the pair view listed the gateway (serial and IP) as "already added".
- **Following address changes:** when a gateway becomes unavailable (or another gateway
  answers at its address), `registry.relocate(serial)` searches the subnet for the same
  serial (single-flight, at most every 10 min per gateway), reconnects there, and every
  device stores the new `host` setting. No DHCP reservation needed.
- **Lifetime meters never decrease** (`updateMeter`), as Homey Energy requires.
- **Connection settings** (host, port, unit ID, poll interval) live on every device and are
  propagated to the gateway's sibling devices. A new address is only accepted when the
  gateway there reports the same serial.
- **Timestamps:** `Snapshot.startedAt` is taken at poll start. Because requests are
  serialised, a snapshot that started after a write reflects that write; the battery uses
  this to detect control being taken back outside Homey without racing its own writes.

### Battery control

| Homey | Gateway |
|---|---|
| `target_power_mode` = `homey` + `target_power` P | 60301 = 1, then 60316 = −P (I32 W) |
| `target_power_mode` = `device` | 60316 = 0, then 60301 = 0 (Atmozen mode: self-consumption / TOU) |
| Flow "charge/discharge to level" | 60314 power, 60312 SOC, 60311 = 0, then 60310 = 0/1 |
| Flow "charge/discharge for a while" | 60314 power, 60313 minutes (≤ 1440), 60311 = 1, then 60310 = 0/1 |
| Flow "stop forced" | 60310 = 2 |

- `target_power` range = the widest of 60029 / 60200 / 60202 ever seen, only widening
  (`widenPowerRange`). None of them is a fixed rating on real hardware: 60029 went from
  7500 to 5000 W on day one, 60200/60202 (kW × **100**) are live limits (0 … 9950 W).
- Pattern follows the Homey docs: `registerMultipleCapabilityListener` (500 ms debounce),
  `target_power` ignored unless mode is `homey`.
- A forced command first leaves Homey mode (dispatch would otherwise fight it).
- After an app restart in `homey` mode the setpoint is re-applied on the first snapshot.
- 60400 "system reset" is deliberately not exposed (semantics undocumented).

## 5. Toolchain

- Homey SDK v3, **TypeScript as ES modules**: sources are `.mts`, imports use `.mts`
  and `rewriteRelativeImportExtensions` emits `.mjs` (Homey loads ESM via `.mjs`,
  compatibility ≥ 12.0.1). `erasableSyntaxOnly` keeps sources runnable by Node's type
  stripping, so tests and tools run without a build step.
- `compatibility: >=12.13.0` (needed for `target_power` / `target_power_mode`).
  Homey ≥ 12.9 runs apps on Node 22.
- TypeScript 6 installed under the `typescript` name (as the Homey CLI does, because
  `eslint-config-athom` 4 does not support TS 7 yet), ESLint 8.57 + `athom/homey-app`.
- `modbus-serial`: CommonJS whose typings claim an ES default export — see the comment in
  `lib/modbus-connection.mts`. `.npmrc` omits its optional native `serialport` dependency.
  The TCP socket is created by us and handed over with `linkTCP` (public API), so connect
  timeout, keep-alive and close handling don't touch library internals.
- `app.json` and `drivers/*/pair/*.html` are **generated** by Homey Compose. Edit
  `.homeycompose/` and `drivers/*/*.compose.json`. The pair view is one template:
  `.homeycompose/drivers/pair/connect/index.html`.

```bash
npm install
npm test                          # unit + simulator integration tests (node:test)
npm run lint                      # eslint (athom config)
npm run typecheck                 # app + tests/tools
npm run validate                  # homey app validate --level publish (also passes `verified`)
npm run simulate                  # simulated gateway on :5020 (serial SIMGW0000001)
node tools/probe.mts 192.168.1.50 --watch 120    # read-only check of a real gateway
homey app install                 # dev install on the selected Homey
homey app run                     # run with live logs (uninstalls on Ctrl+C)
```

On WSL in NAT mode the Homey cannot reach the simulator; run it on a machine in the LAN.

## 6. Localisation

All 13 Homey languages (en, nl, de, fr, it, sv, no, es, da, ru, pl, ko, ar) everywhere:
manifest, capability, settings, Flow cards, `locales/*.json` (runtime + pair view) and
`README.<lang>.txt`. Runtime placeholders use Homey's `__name__` syntax. The pair view
uses `data-i18n` / `Homey.__()` and logical CSS properties for RTL (Arabic).
When adding a string, add it in all 13 languages in the same change.

## 7. Assets and store

- App icon: the "A" of the official ATMOCE wordmark (vectorised from the logo in Atmoce's
  datasheets), scaled to fill the 960 canvas. Atmoce has no separate symbol (its favicon is
  the wordmark too), and the full wordmark is unreadable at the store's small icon sizes
  ("must be recognizable at small sizes"); a single-letter monogram passed certification for
  the Toshiba Estia app.
- App images: Atmoce's lifestyle photo (MC100 datasheet); driver images: product photos
  from the datasheets (MI microinverter, MS-7K-U, MC100) on white.
  **Get Atmoce's written permission to use their logo and photos before publishing.**
- Driver icons are hand-drawn line icons (960×960, stroke 32).
- `brandColor` `#D1606D`: the middle of Atmoce's own logo gradient (#E47478 → #C34E68); brightness ≈ 131, limit 184.
- Store rules (apps.developer.homey.app/app-store/guidelines): README one or two paragraphs,
  plain text, no URLs, no changelog; description a one-liner, not "Adds support for"; Flow
  titles without device names, When/And/Then or parentheses; app images lifestyle, not
  screenshots; widget previews 1024² transparent, simple shapes, no text.
- Store texts (tagline, tags, README.*.txt, changelog) are written by the scratchpad
  generator gen_store.py; widget previews by gen_preview.py (headless Chrome, 1024², cropped).
- Before publishing: create the GitHub repo in `source`/`support`, open a Homey Community
  topic and set `homeyCommunityTopicId`, bump version + `.homeychangelog.json` (13 languages).

### Derived values and threshold Flow cards

- Grid meter: `measure_power.consumption` = PV + grid + battery (gateway sign), clamped ≥ 0;
  `meter_power.consumption_today` and `measure_self_sufficiency` (1 − import ÷ consumption)
  from the gateway's daily counters. Homey Energy only reads the main `measure_power` of a
  cumulative device, so nothing is counted twice. Verified on hardware: 3673 + 19 − 1706 = 1986 W.
- Battery: `measure_battery_energy` = SOC × capacity (60031); `measure_time_to_full/empty`
  at the current power (≥ 50 W). Estimates: the charge/discharge cut-off SOC is not in the spec.
- Crossing cards (`battery_level_below/above`, `grid_import_above`, `grid_export_above`) are
  triggered every change with state `{previous, current}`; the run listener checks the
  crossing for that Flow's argument, so each Flow fires once per crossing.
- Started/stopped cards use `Hysteresis` (grid 50 W on / 20 W off, solar 20 W / 5 W). The
  first reading after start only sets the state. Conditions read the same state.
- Capabilities added after pairing are appended with `addMissingCapabilities`; Homey applies
  the manifest `capabilitiesOptions` (titles) to them — verified on Homey 13.5.0.

### Power limits (spec V1.3 registers, firmware ≥ 01.01.00.29)

| Homey | Register |
|---|---|
| Grid: "Limit export to X W" / "Allow unlimited export"; condition "Export is limited" | 60324 |
| Grid: "Limit grid import to X W" / "Allow unlimited grid import"; condition | 60326 |
| Battery: "Limit charging / discharging to X W", "Remove the charge and discharge limits" | 60318 / 60320 |
| Solar: `target_power` + `target_power_mode` (Homey Energy curtailment), cards "Limit solar production to X W" / "Remove the solar production limit" | 60322 |

- U32 W, 0xFFFFFFFF = no limit. Read back every poll (`powerLimits` block, optional), so
  Homey shows what the gateway really enforces (also limits set by e.g. evcc).
- Spec V1.6: accepted only while 60301 = 1 or 60310 ≠ 2. `AtmoceGateway.setPowerLimit`
  therefore sets 60310 = 4 (self-consumption, V1.3) first when in normal mode, and back to
  2 when the last limit is removed. `stopForced` / `resumeLocalControl` keep 4 while limits
  are active, and each poll re-asserts 4 (≤ every 5 min) if the gateway dropped back to 2.
- Firmware below .29: the cards throw `errors.needs_firmware`; solar curtailment is not added.
- **Atmozen "Grid recharging" and "Export power to grid" gate grid flows** (not on Modbus, not in
  the official cloud API). ✅ VERIFIED 2026-10-06 (MC100 fw .29.03): forced charge 3000 W with
  grid recharging off charged only PV − home (grid 0 W, also via dispatch 60316); with it on,
  exactly 3000 W with the grid adding ±1220 W. Forced discharge 3000 W with export off stayed at
  0 W while PV covered the home. The spec's "may be charged from the grid" note is wrong for this
  setup (the old card hint said so; fixed in 1.0.4). `lib/grid-permission.mts` recognises it
  (3 min, battery below 80 % of the request and no more than PV − home / home load) and the
  battery device puts one timeline message per switch per day.
- **60310 decisions use the app's own last write** (`currentForcedCommand`), not only the last
  snapshot: Flow cards run back to back, faster than the next poll. Bug found 2026-10-06: TEMPO
  ROOD's "charge to 100 %" followed directly by "limit discharging to 0 W" read a stale
  60310 = 2, wrote 4 to get the limit accepted and so cancelled the forced charge. A limit set
  during a forced run is accepted as is (60310 ≠ 2), and removing the last limit only writes
  60310 = 2 when 60310 is still 4 (a forced run that started meanwhile keeps running).
  Covered by the "red night" tests in `test/gateway.test.mts`.
- Active limits count as "commanded" for `LimitLearner` (live limits then reflect the caps).
- ✅ VERIFIED 2026-09-28 (MC100, fw 01.01.00.29.03, user-requested temporary test): in
  normal mode `setPowerLimit('discharge', 1000)` wrote 60310 = 4 then 60320 = 1000; the
  battery went from 3923 W to 1000 W (±2 W) within ~7 s and kept self-consuming (grid covered
  the rest). Removing it wrote 60320 = 0xFFFFFFFF then 60310 = 2; back to ~4130 W within ~5 s.
  So 60310 = 4 behaves like normal self-consumption and the limits are exact.
- Still unverified: export / PV / import limits on hardware (same mechanism), whether limits
  survive a gateway restart (the app re-asserts mode 4 anyway), and the interaction with
  Atmozen's "Export Power to Grid" switch.

### Energy-flow widget (`widgets/energy-flow/`)

- Homey Dashboard tile: solar / grid / home / battery nodes with animated flows (dots move
  along a line in the flow direction, faster with more power; flows < 10 W are hidden as
  noise), battery SOC ring and state, optional "today" row (produced, consumed,
  self-sufficiency). Uses Homey's widget CSS variables → light/dark mode for free.
- Data: `lib/energy-flow.mts` (pure, tested) splits the snapshot into flows (solar serves
  home → battery → grid; home is then served by battery → grid). The app pushes it on every
  poll with `homey.api.realtime('energyflow', …)`; the widget also fetches once via
  `GET /?serial=` (`widgets/energy-flow/api.mts`).
- Setting `gateway` (autocomplete of gateways by serial, registered in app.mts) is only
  needed with more than one gateway; empty = the first one. `show_today` toggles the row.
- The design is our own implementation of the common "power flow" layout (as popularised by
  Home Assistant's power-flow-card-plus); no Atmoce artwork is used.
- Preview images: 1024×1024, transparent, no text or screenshots (Homey guideline), light and dark: the widget card with shadow, its layout, and grey bars where the real widget shows values (scratchpad gen_preview3.py). Real screenshots live in docs/images for the GitHub README only.

### Solar surplus cards (`lib/surplus.mts`, grid meter)

- Battery first, as evcc: surplus = grid export (what the battery can no longer absorb);
  deficit = grid import + battery discharge. Without a battery both reduce to export / import.
- 2-minute rolling average (a passing cloud does not reset a timer); 240 minutes of averaged
  samples are kept so "held for N minutes" works for any Flow's power/duration without
  per-Flow state; a gap longer than max(90 s, 3 × poll interval) breaks "held".
- Triggers fire once at the poll where the condition is first reached (edge on the history).
  After an app restart a duration starts from zero.
- Stop on deficit ≥ 200 W, not on "surplus below threshold": the appliance consumes the
  surplus itself, and a full Atmoce battery covers dips, so grid import alone would let an
  appliance drain the battery. Design from evcc, PV Excess Control, SMA, Fronius, Loxone docs.
- No battery-level token: it would read 0 % on systems without a battery.
- Grid meter setting `surplus_battery_first` (default 100, group id `surplus_group`): from that
  battery level on, charging power counts as surplus (evcc `prioritySoc`). One dial instead of a
  second "with/without battery" card set: the two definitions only differ while the battery
  charges, and are identical without one. Load-first gains ~1–2 c/kWh (storage losses) when the
  battery fills anyway; whether it loses depends on what the energy would cost otherwise.

### Timeline notifications and diagnostics

- Device alarms (`AtmoceDevice.notify`): solar system fault (60066), battery faulty / all shut
  down (60098), grid outage (60096), and their all-clears with the duration (start time in the
  store). Each alarm carries `notify.context`: firmware, solar W, SOC, battery and grid W. The
  gateway has no alarm-code register (spec §4.3 lists Modbus exceptions only), so the text
  points to the Atmozen app for the alarm details.
- Gateway alerts (`lib/gateway-alerts.mts`, wired in app.mts) go out once per gateway, when
  any of its devices has `timeline_notifications` on. Firmware: last version per serial in
  app setting `firmware`, seeded from the devices' `firmware_version` label, so the first run
  after an upgrade does not report anything.
- Diagnostics labels (`diag_*`) are rewritten on connection changes, identity, the test
  action, and otherwise at most every 10 minutes (setSettings is a disk write).
  `setLastSeenAt()` at most every minute (missing from the SDK typings, hence the local
  interface in atmoce-device.mts).
- Maintenance action `button.test_connection` (capabilitiesOptions `maintenanceAction`).
  VERIFIED 2026-09-28 on Homey Pro 13.5.0: added to existing devices by `addCapability` with
  the manifest title; the report arrived on the timeline in Dutch.

### No target power sliders on the device screen

`capabilitiesOptions.target_power.uiComponent: null` on battery and solar (as the Sessy app; of
six Homey battery apps checked only Sessy hides it). The big slider was far too easy to hit by
accident. The capability keeps working for Homey Energy and its Flow cards; the mode picker stays.
`setCapabilityOptions` replaces options, so runtime range updates spread `manifestOptions()`;
existing devices are migrated once (battery store `targetPowerOptions`, solar `curtailmentOptions`
`:v3`). VERIFIED 2026-09-29 on Homey Pro 13.5: the slider component is gone from both devices.

### Device indicator

Homey groups `alarm_` capabilities into the default indicator ("By default all capabilities
with this prefix are grouped", capabilities docs), and there is no manifest option to pick
the default. Hence: no `alarm_` capability on the solar device (fault = `setWarning` +
`system_fault_*` Flow cards), `measure_battery` first in the battery's capability list, and
`measure_power.consumption` first on the grid meter (observed: an untouched device shows its
first `measure_` capability; verify on the next fresh grid-meter pairing).

## 8. Common pitfalls

| Pitfall | Why |
|---|---|
| Reading across a reserved register row | Gateway may answer exception 0x02; keep `BLOCKS` to documented ranges |
| Treating 60200/60202 as kW × 1000 | They are kW × 100 (W = raw × 10) |
| Using the IP as device id | DHCP changes it; the serial is stable (and relocation finds it again) |
| Making a new register block required | Older firmware may not have it: add it as optional (`readOptional`) |
| Opening a second connection during pairing | Possibly refused by the gateway; use `registry.probe()` |
| Global `setTimeout`/`setInterval` in app code | Use `this.homey.*` timers (passed into the gateway) |
| Editing `app.json` or generated pair views | Overwritten by Homey Compose on every build |
| `setSettings()` expecting `onSettings` | It does not fire; propagation relies on that |
| A setting id equal to a settings-group id | Homey 13.5 then rejects **every** `setSettings` ("Invalid Value Type For Setting: …"), silently breaking all label updates; hence group `notifications_group` for setting `timeline_notifications` |
| Trusting every `target_power` / `target_power_mode` listener call | The mobile app can re-send cached values when a device page opens (seen in Sessy, Anker, Marstek apps); `BatteryDevice.isRepeat` ignores changes that repeat current values |
