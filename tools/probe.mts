/**
 * Read-only diagnostic for a real Atmoce gateway. Never writes a register.
 *
 *   node tools/probe.mts <ip> [--port 502] [--unit 1] [--watch <seconds>]
 *
 * Prints the identity and every documented register block, decoded, then checks the two
 * sign conventions the spec leaves open (lib/registers.mts):
 * - battery 60071: negative while the storage status says "charging"?
 * - grid 60073: positive while the import counter rises? (needs --watch, e.g. 120)
 */
import { ModbusConnection } from '../lib/modbus-connection.mts';
import {
  BLOCKS,
  type Energy,
  type Status,
  decodeControl,
  decodeEnergy,
  decodeIdentity,
  decodeLimits,
  decodePhases,
  decodeStatus,
} from '../lib/registers.mts';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function probe(connection: ModbusConnection, watchS: number): Promise<void> {
  const read = (block: { start: number; length: number }) => connection.readRegisters(block.start, block.length);
  const sample = async (): Promise<{ status: Status; energy: Energy }> => ({
    status: decodeStatus(await read(BLOCKS.status)),
    energy: decodeEnergy(await read(BLOCKS.energy)),
  });

  const identity = decodeIdentity(await read(BLOCKS.identity));
  const status = decodeStatus(await read(BLOCKS.status));
  const phases = decodePhases(await read(BLOCKS.phases));
  const energy = decodeEnergy(await read(BLOCKS.energy));
  const limits = decodeLimits(await read(BLOCKS.limits));
  const control = decodeControl(await read(BLOCKS.control), await read(BLOCKS.forced));
  console.log(JSON.stringify({
    identity, status, phases, energy, limits, control,
  }, null, 2));

  console.log('\nSign checks');
  const house = status.pvPowerW + status.gridPowerW + status.storagePowerW;
  console.log(`- House load implied by the assumed signs (PV + grid + battery): ${house} W ${house >= 0 ? '(plausible)' : '(NEGATIVE: a sign is wrong)'}`);
  if (status.storageStatus === 'charging' || status.storageStatus === 'discharging') {
    const expectNegative = status.storageStatus === 'charging';
    const ok = expectNegative ? status.storagePowerW < 0 : status.storagePowerW > 0;
    console.log(`- Battery: status ${status.storageStatus}, 60071 = ${status.storagePowerW} W → ${ok ? 'matches' : 'CONTRADICTS'} "positive = discharging"`);
  } else {
    console.log('- Battery: idle right now, run again while it charges or discharges');
  }

  if (watchS > 0) {
    console.log(`- Grid: watching ${watchS} s…`);
    const start = await sample();
    let gridSum = 0;
    let samples = 0;
    const endAt = Date.now() + watchS * 1000;
    let last = start;
    while (Date.now() < endAt) {
      await sleep(5000);
      last = await sample();
      gridSum += last.status.gridPowerW;
      samples += 1;
    }
    const imported = last.energy.importedTodayKwh - start.energy.importedTodayKwh;
    const exported = last.energy.exportedTodayKwh - start.energy.exportedTodayKwh;
    const average = Math.round(gridSum / Math.max(samples, 1));
    console.log(`  average 60073 = ${average} W, imported +${imported.toFixed(2)} kWh, exported +${exported.toFixed(2)} kWh`);
    if (imported === exported) {
      console.log('  counters did not move (0.01 kWh resolution): watch longer or with more grid power');
    } else {
      const importing = imported > exported;
      const ok = importing ? average > 0 : average < 0;
      console.log(`  → ${ok ? 'matches' : 'CONTRADICTS'} "positive = import"`);
    }
  }
}

const host = process.argv[2];
if (!host || host.startsWith('--')) {
  console.error('Usage: node tools/probe.mts <ip> [--port 502] [--unit 1] [--watch <seconds>]');
  process.exitCode = 2;
} else {
  const connection = new ModbusConnection(
    { host, port: Number(argument('port', '502')), unitId: Number(argument('unit', '1')) },
    { log: () => undefined, error: console.error },
  );
  try {
    await probe(connection, Number(argument('watch', '0')));
  } finally {
    await connection.close();
  }
}
