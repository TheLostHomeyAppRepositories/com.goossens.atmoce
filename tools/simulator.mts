/**
 * Simulated Atmoce gateway: serves the register map of the official Modbus spec V1.2 over
 * Modbus TCP, for the integration tests and for trying the app without hardware.
 *
 *   node tools/simulator.mts [port]        (default port 5020, all interfaces)
 *
 * Only documented registers can be read or written; anything else answers with Modbus
 * exception 0x02 (illegal data address), like the reserved rows in the spec.
 *
 * Behaviour modelled from the spec:
 * - #43 (60301) = 1 switches the operating mode #14 (60068) to 10 "remote"; 0 restores it.
 * - In remote mode the battery follows the dispatch power #52 (60316).
 * - Forced charge/discharge #47 (60310) sets the storage status #13 (60067).
 * Sign conventions follow what the app assumes (see lib/registers.mts): 60071 and 60316
 * positive = discharging, 60073 positive = importing.
 */
import { fileURLToPath } from 'node:url';

import modbusSerial from 'modbus-serial';

type ServerTCPClass = (typeof modbusSerial)['ServerTCP'];
type ServerTCP = InstanceType<ServerTCPClass>;
const { ServerTCP: ModbusServer } = modbusSerial as unknown as { ServerTCP: ServerTCPClass };

export interface SimulatorOptions {
  port?: number;
  host?: string;
  unitId?: number;
  serial?: string;
  /** Advance energy counters from the simulated power every second (interactive mode). */
  live?: boolean;
  /** Register ranges this simulated firmware does not have (older gateways). */
  missing?: ReadonlyArray<[number, number]>;
  /** Firmware string in 60011 (default: the real MC100 after its first update). */
  firmware?: string;
}

export interface WriteRecord {
  address: number;
  values: number[];
}

/** Register ranges documented in table 3.1 (start, length). */
const DOCUMENTED: ReadonlyArray<[number, number]> = [
  [60000, 33], [60060, 6], [60066, 13], [60089, 7], [60096, 3], [60160, 30], [60200, 4],
  [60301, 4], [60310, 8], [60318, 10], [60400, 1],
];
const WRITABLE: ReadonlyArray<[number, number]> = [[60301, 4], [60310, 8], [60318, 10], [60400, 1]];

function inRanges(ranges: ReadonlyArray<[number, number]>, address: number, length: number): boolean {
  return ranges.some(([start, size]) => address >= start && address + length <= start + size);
}

function illegalAddress(): { modbusErrorCode: number; msg: string } {
  return { modbusErrorCode: 0x02, msg: 'Illegal data address' };
}

function words32(value: number): [number, number] {
  const v = value < 0 ? value + 0x100000000 : value;
  return [Math.floor(v / 0x10000) & 0xffff, v & 0xffff];
}

function words64(value: number): number[] {
  let v = BigInt(Math.round(value));
  const out: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    out.unshift(Number(v & 0xffffn));
    v >>= 16n;
  }
  return out;
}

function ascii(text: string, registers: number): number[] {
  const padded = text.padEnd(registers * 2, '\0');
  return Array.from({ length: registers }, (_, i) => (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}

function signed32(high: number, low: number): number {
  const v = high * 0x10000 + low;
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

export class AtmoceSimulator {

  readonly registers = new Map<number, number>();
  readonly writes: WriteRecord[] = [];
  /** Local operating mode restored when remote control ends (1 self-consumption, 2 TOU). */
  localMode = 1;

  private server: ServerTCP | null = null;
  /** Energy counters in exact kWh × 100, so sub-resolution increments are not lost. */
  private readonly counters = new Map<number, number>();
  private ticker: NodeJS.Timeout | null = null;
  private readonly options: Required<SimulatorOptions>;

  constructor(options: SimulatorOptions = {}) {
    this.options = {
      port: 5020, host: '127.0.0.1', unitId: 1, serial: 'SIMGW0000001', live: false, missing: [], firmware: '01.01.00.29.03', ...options,
    };
    this.reset();
  }

  get port(): number {
    return this.options.port;
  }

  get serial(): string {
    return this.options.serial;
  }

  /** Default state: 4 kW PV producing 2.5 kW, 2 × MS-7K-U (14 kWh), self-consumption. */
  reset(): void {
    this.registers.clear();
    this.writes.length = 0;
    this.counters.clear();
    this.set(60000, ascii(this.options.serial, 10));
    this.set(60010, [0x0200]);
    this.set(60011, ascii(this.options.firmware, 15));
    this.set(60026, [0x0101]);
    this.set(60027, words32(4000)); // rated PV, kW × 1000
    this.set(60029, words32(7500)); // rated storage power
    this.set(60031, words32(14000)); // capacity, kWh × 1000
    this.set(60060, [...words32(0), ...words32(3600), ...words32(0)]);
    this.set(60066, [0, 99, 1]);
    this.setPower({ pvW: 2500, storageW: 0, gridW: 1500 - 2500 }); // 1.5 kW house load, exporting
    this.set(60075, [...words32(0), ...words32(0)]);
    this.set(60089, [2310, 0, 0, 0, 0, 0, 57]);
    this.set(60096, [0, 0, 0]); // V1.5: on grid, running status idle
    this.set(60160, [...words64(123456), ...words32(1234)]); // PV 1234.56 kWh total, 12.34 today
    this.set(60166, [...words64(50000), ...words32(500)]);
    this.set(60172, [...words64(40000), ...words32(400)]);
    this.set(60178, [...words64(30000), ...words32(300)]);
    this.set(60184, [...words64(20000), ...words32(200)]);
    this.set(60200, [...words32(750), ...words32(900)]); // kW × 100 → 7.5 / 9 kW
    this.set(60301, [0, ...words32(0), 0]);
    this.set(60310, [2, 0, 0, 0, ...words32(0), ...words32(0)]);
    this.set(60318, new Array(10).fill(0xffff)); // V1.3 power limits: no limit
    this.set(60400, [0]);
  }

  set(address: number, values: number[]): void {
    values.forEach((value, i) => this.registers.set(address + i, value & 0xffff));
  }

  get(address: number): number {
    return this.registers.get(address) ?? 0;
  }

  setPower({ pvW, storageW, gridW }: { pvW: number; storageW: number; gridW: number }): void {
    this.set(60069, [...words32(pvW), ...words32(storageW), ...words32(gridW)]);
  }

  async start(): Promise<void> {
    const vector = {
      getMultipleHoldingRegisters: (address: number, length: number, unitId: number): number[] => {
        if (unitId !== this.options.unitId || !this.readable(address, length)) throw illegalAddress();
        return Array.from({ length }, (_, i) => this.get(address + i));
      },
      getHoldingRegister: (address: number, unitId: number): number => {
        if (unitId !== this.options.unitId || !this.readable(address, 1)) throw illegalAddress();
        return this.get(address);
      },
      setRegister: (address: number, value: number, unitId: number): void => {
        if (unitId !== this.options.unitId || !inRanges(WRITABLE, address, 1)) throw illegalAddress();
        this.write(address, [value]);
      },
      setRegisterArray: (address: number, values: number[], unitId: number): void => {
        if (unitId !== this.options.unitId || !inRanges(WRITABLE, address, values.length)) throw illegalAddress();
        this.write(address, values);
      },
    };
    await new Promise<void>((resolve, reject) => {
      const server = new ModbusServer(vector, { host: this.options.host, port: this.options.port, unitID: this.options.unitId });
      server.on('initialized', () => resolve());
      server.on('serverError', (err) => reject(err));
      this.server = server;
    });
    if (this.options.live) this.ticker = setInterval(() => this.tick(1), 1000);
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    const { server } = this;
    this.server = null;
    if (!server) return;
    for (const socket of server.socks.keys()) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private readable(address: number, length: number): boolean {
    const missing = this.options.missing.some(([start, size]) => address < start + size && address + length > start);
    return !missing && inRanges(DOCUMENTED, address, length);
  }

  /** Records ignored writes: spec V1.6 accepts 60318–60326 only while 60301 = 1 or 60310 ≠ 2. */
  readonly ignoredWrites: WriteRecord[] = [];

  private write(address: number, values: number[]): void {
    this.writes.push({ address, values: [...values] });
    const isPowerLimit = address >= 60318 && address < 60328;
    if (isPowerLimit && this.get(60301) !== 1 && this.get(60310) === 2) {
      this.ignoredWrites.push({ address, values: [...values] });
      return;
    }
    this.set(address, values);
    const remote = this.get(60301) === 1;
    this.set(60068, [remote ? 10 : this.localMode]);
    if (address <= 60310 && address + values.length > 60310) this.applyForcedCommand();
    if (remote) this.followDispatch();
  }

  private applyForcedCommand(): void {
    const command = this.get(60310);
    const powerW = this.get(60314) * 0x10000 + this.get(60315);
    if (command === 0) this.setStorage(-powerW);
    else if (command === 1) this.setStorage(powerW);
    else this.setStorage(0);
  }

  private followDispatch(): void {
    this.setStorage(signed32(this.get(60316), this.get(60317)));
  }

  /** Storage power in gateway convention (+ discharging); grid balances a 1.5 kW house load. */
  private setStorage(storageW: number): void {
    const pvW = this.get(60069) * 0x10000 + this.get(60070);
    this.setPower({ pvW, storageW, gridW: 1500 - pvW - storageW });
    let status = 99;
    if (storageW < 0) status = 1;
    if (storageW > 0) status = 2;
    this.set(60067, [status]);
    this.set(60098, [{ 99: 0, 1: 1, 2: 2 }[status] ?? 0]);
  }

  /** Integrates power into the energy counters (live mode). */
  private tick(seconds: number): void {
    const kwh100 = (w: number) => ((w * seconds) / 3600 / 1000) * 100;
    const read64 = (a: number) => [0, 1, 2, 3].reduce((acc, i) => acc * 0x10000 + this.get(a + i), 0);
    const read32 = (a: number) => this.get(a) * 0x10000 + this.get(a + 1);
    const accumulate = (address: number, read: (a: number) => number, delta: number) => {
      const value = (this.counters.get(address) ?? read(address)) + delta;
      this.counters.set(address, value);
      return Math.floor(value);
    };
    const add = (total: number, today: number, w: number) => {
      if (w <= 0) return;
      this.set(total, words64(accumulate(total, read64, kwh100(w))));
      this.set(today, words32(accumulate(today, read32, kwh100(w))));
    };
    const pvW = read32(60069);
    const storageW = signed32(this.get(60071), this.get(60072));
    const gridW = signed32(this.get(60073), this.get(60074));
    add(60160, 60164, pvW);
    add(60166, 60170, -storageW);
    add(60172, 60176, storageW);
    add(60184, 60188, gridW);
    add(60178, 60182, -gridW);
  }

}

// Run standalone: node tools/simulator.mts [port]
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? 5020);
  const simulator = new AtmoceSimulator({ port, host: '0.0.0.0', live: true });
  await simulator.start();
  console.log(`Atmoce simulator ${simulator.serial} listening on 0.0.0.0:${port} (unit 1). Ctrl+C to stop.`);
}
