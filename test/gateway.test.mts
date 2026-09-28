import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  after, before, beforeEach, describe, it,
} from 'node:test';

import { scanForGateways, subnetHosts } from '../lib/discovery.mts';
import { AtmoceGateway, type Snapshot } from '../lib/gateway.mts';
import { GatewayRegistry } from '../lib/gateway-registry.mts';
import { ModbusConnection, isModbusException } from '../lib/modbus-connection.mts';
import { AtmoceSimulator } from '../tools/simulator.mts';

const PORT = 15020;
const quiet = { log: () => undefined, error: () => undefined };
const timers = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout),
};

function gatewayFor(serial: string, pollIntervalMs = 60_000): AtmoceGateway {
  return new AtmoceGateway({
    endpoint: { host: '127.0.0.1', port: PORT, unitId: 1 },
    pollIntervalMs,
    expectedSerial: serial,
    timers,
    logger: quiet,
  });
}

async function nextSnapshot(gateway: AtmoceGateway): Promise<Snapshot> {
  const [snapshot] = await once(gateway, 'snapshot') as [Snapshot];
  return snapshot;
}

describe('AtmoceGateway against the simulator', () => {
  const simulator = new AtmoceSimulator({ port: PORT });
  let gateway: AtmoceGateway;

  before(async () => {
    await simulator.start();
  });

  after(async () => {
    await simulator.stop();
  });

  beforeEach(async () => {
    simulator.reset();
    await gateway?.stop();
    gateway = gatewayFor(simulator.serial);
  });

  after(async () => {
    await gateway?.stop();
  });

  it('reads identity and a full snapshot', async () => {
    const identity = once(gateway, 'identity');
    const snapshot = nextSnapshot(gateway);
    gateway.start();
    const [id] = await identity;
    assert.equal(id.serial, simulator.serial);
    assert.equal(id.firmwareVersion, '01.01.00.29.03');
    assert.equal(gateway.supportsPowerLimits, true);
    assert.equal(id.storageCapacityKwh, 14);
    const snap = await snapshot;
    assert.equal(snap.status.pvPowerW, 2500);
    assert.equal(snap.status.storageStatus, 'idle');
    assert.equal(snap.status.storageMode, 'self_consumption');
    assert.equal(snap.phases.socPercent, 57);
    assert.equal(snap.phases.phases[0].voltageV, 231);
    assert.equal(snap.energy.pvTotalKwh, 1234.56);
    assert.deepEqual(snap.limits, { maxChargePowerW: 7500, maxDischargePowerW: 9000 });
    assert.equal(snap.control?.remoteControl, false);
    assert.equal(gateway.isAvailable, true);
  });

  it('test connection and diagnostics', async () => {
    gateway.start();
    await nextSnapshot(gateway);
    const { identity, roundTripMs } = await gateway.testConnection();
    assert.equal(identity.serial, simulator.serial);
    assert.ok(roundTripMs >= 0);
    assert.ok(gateway.connectedSince !== null);
    assert.equal(gateway.unavailableSince, null);
    assert.deepEqual(gateway.stats, { polls: 1, failed: 0 });
    assert.deepEqual(gateway.blockSupport.map(({ start, support }) => [start, support]), [
      [60200, 'yes'], [60301, 'yes'], [60310, 'yes'], [60096, 'yes'], [60318, 'yes'],
    ]);
  });

  it('dispatch: remote mode first, then the (inverted) dispatch power', async () => {
    gateway.start();
    await nextSnapshot(gateway);
    const refreshed = nextSnapshot(gateway);
    await gateway.setDispatchPower(3000); // Homey: + charge
    assert.deepEqual(simulator.writes, [
      { address: 60301, values: [1] },
      { address: 60316, values: [0xffff, 0xf448] }, // −3000 = charge
    ]);
    const snap = await refreshed;
    assert.equal(snap.control?.remoteControl, true);
    assert.equal(snap.control?.dispatchPowerW, -3000);
    assert.equal(snap.status.storageMode, 'remote');
    assert.equal(snap.status.storageStatus, 'charging');
  });

  it('resume local control: dispatch 0, then local mode', async () => {
    gateway.start();
    await nextSnapshot(gateway);
    await gateway.setDispatchPower(-2000);
    simulator.writes.length = 0;
    await gateway.resumeLocalControl();
    assert.deepEqual(simulator.writes, [
      { address: 60316, values: [0, 0] },
      { address: 60301, values: [0] },
    ]);
    assert.equal(simulator.get(60068), 1);
  });

  it('forced charge: parameters before the command', async () => {
    gateway.start();
    await nextSnapshot(gateway);
    await gateway.force('charge', { kind: 'target_soc', socPercent: 90, powerW: 2500 });
    assert.deepEqual(simulator.writes, [
      { address: 60314, values: [0, 2500] },
      { address: 60312, values: [90] },
      { address: 60311, values: [0] },
      { address: 60310, values: [0] },
    ]);
    simulator.writes.length = 0;
    await gateway.force('discharge', { kind: 'duration', minutes: 5000, powerW: 1000 });
    assert.deepEqual(simulator.writes, [
      { address: 60314, values: [0, 1000] },
      { address: 60313, values: [1440] }, // clamped to the spec's [0, 1440]
      { address: 60311, values: [1] },
      { address: 60310, values: [1] },
    ]);
    simulator.writes.length = 0;
    await gateway.stopForced();
    assert.deepEqual(simulator.writes, [{ address: 60310, values: [2] }]);
  });

  it('power limit: enters self-consumption (4) first so the gateway accepts it', async () => {
    gateway.start();
    await nextSnapshot(gateway);
    await gateway.setPowerLimit('export', 0);
    assert.deepEqual(simulator.writes, [
      { address: 60310, values: [4] },
      { address: 60324, values: [0, 0] },
    ]);
    assert.deepEqual(simulator.ignoredWrites, []);
    const snap = await nextSnapshot(gateway);
    assert.equal(snap.powerLimits?.export, 0);
    assert.equal(snap.control?.forcedCommand, 'self_consumption');
  });

  it('power limit: removing the last one returns to normal mode (2)', async () => {
    gateway.start();
    await nextSnapshot(gateway);
    await gateway.setPowerLimit('discharge', 400);
    await nextSnapshot(gateway);
    simulator.writes.length = 0;
    await gateway.setPowerLimit('discharge', null);
    assert.deepEqual(simulator.writes, [
      { address: 60320, values: [0xffff, 0xffff] },
      { address: 60310, values: [2] },
    ]);
  });

  it('power limit: stop forced and return to local keep active limits working', async () => {
    gateway.start();
    await nextSnapshot(gateway);
    await gateway.setPowerLimit('export', 0);
    await nextSnapshot(gateway);
    simulator.writes.length = 0;
    await gateway.stopForced();
    assert.deepEqual(simulator.writes, [{ address: 60310, values: [4] }]);
  });

  it('power limit: re-asserts self-consumption when the gateway dropped back to normal', async () => {
    simulator.set(60310, [2]);
    simulator.set(60324, [0, 0]); // a limit left active, e.g. before a gateway restart
    gateway.start();
    await nextSnapshot(gateway);
    const reasserted = () => simulator.writes.filter((w) => w.address === 60310);
    for (let i = 0; i < 50 && reasserted().length === 0; i += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    assert.deepEqual(reasserted(), [{ address: 60310, values: [4] }]);
  });

  it('reports a different gateway at the address as unavailable', async () => {
    await gateway.stop();
    gateway = gatewayFor('OTHERSERIAL');
    const unavailable = once(gateway, 'unavailable');
    gateway.start();
    const [reason] = await unavailable;
    assert.match(reason, /SIMGW0000001/);
    assert.equal(gateway.isAvailable, false);
    await assert.rejects(gateway.testConnection(), /SIMGW0000001/);
  });

  it('reconnects after the gateway restarts', async () => {
    await gateway.stop();
    gateway = gatewayFor(simulator.serial, 50);
    gateway.start();
    await nextSnapshot(gateway);
    const connectedAt = gateway.connectedSince;
    await simulator.stop();
    await once(gateway, 'unavailable');
    assert.equal(gateway.connectedSince, null);
    assert.ok(gateway.unavailableSince !== null && connectedAt !== null && gateway.unavailableSince >= connectedAt);
    assert.ok(gateway.lastFailure !== null);
    await simulator.start();
    await once(gateway, 'available');
    assert.equal(gateway.isAvailable, true);
    assert.equal(gateway.unavailableSince, null);
    assert.ok(gateway.connectedSince !== null);
    assert.ok(gateway.stats.failed >= 3);
    assert.ok(gateway.lastFailure !== null, 'the last failure stays visible after recovery');
  });
});

describe('older gateway firmware without the optional blocks', () => {
  const simulator = new AtmoceSimulator({
    port: PORT + 3,
    firmware: '01.01.00.18.10',
    missing: [[60200, 4], [60301, 4], [60310, 8], [60096, 3], [60318, 10]],
  });

  before(async () => {
    await simulator.start();
  });

  after(async () => {
    await simulator.stop();
  });

  it('keeps delivering the core measurements', async () => {
    const gateway = new AtmoceGateway({
      endpoint: { host: '127.0.0.1', port: PORT + 3, unitId: 1 },
      pollIntervalMs: 20,
      expectedSerial: simulator.serial,
      timers,
      logger: quiet,
    });
    const snapshots: Snapshot[] = [];
    gateway.on('snapshot', (snapshot: Snapshot) => snapshots.push(snapshot));
    gateway.start();
    while (snapshots.length < 5) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    await gateway.stop();
    const last = snapshots.at(-1) as Snapshot;
    assert.equal(gateway.lastError, null);
    assert.equal(last.status.pvPowerW, 2500);
    assert.equal(last.phases.socPercent, 57);
    assert.equal(last.limits, null);
    assert.equal(last.control, null);
    assert.equal(last.gridState, null);
    assert.equal(last.powerLimits, null);
    assert.equal(gateway.supportsPowerLimits, false);
    assert.ok(gateway.blockSupport.every(({ support }) => support === 'no'));
  });
});

describe('ModbusConnection', () => {
  const simulator = new AtmoceSimulator({ port: PORT + 1 });

  before(async () => {
    await simulator.start();
  });

  after(async () => {
    await simulator.stop();
  });

  it('keeps the connection after a Modbus exception (reserved register)', async () => {
    const connection = new ModbusConnection({ host: '127.0.0.1', port: PORT + 1, unitId: 1 }, quiet);
    try {
      await assert.rejects(connection.readRegisters(60033, 2), (err) => isModbusException(err) && err.modbusCode === 2);
      assert.equal(connection.connected, true);
      assert.equal((await connection.readRegisters(60095, 1))[0], 57);
      assert.equal(connection.connectionCount, 1);
    } finally {
      await connection.close();
    }
  });

  it('fails fast when nothing listens', async () => {
    const connection = new ModbusConnection({ host: '127.0.0.1', port: PORT + 9, unitId: 1 }, quiet, 1000);
    try {
      await assert.rejects(connection.readRegisters(60000, 1), /ECONNREFUSED|Timed out/);
    } finally {
      await connection.close();
    }
  });
});

describe('GatewayRegistry', () => {
  const simulator = new AtmoceSimulator({ port: PORT + 2 });

  before(async () => {
    await simulator.start();
  });

  after(async () => {
    await simulator.stop();
  });

  it('probes identity and phase count, and shares one gateway per serial', async () => {
    const registry = new GatewayRegistry(timers, quiet, async () => '127.0.0.1:80');
    const endpoint = { host: '127.0.0.1', port: PORT + 2, unitId: 1 };
    const probe = await registry.probe(endpoint);
    assert.equal(probe.identity.serial, simulator.serial);
    assert.equal(probe.phaseCount, 1);

    const settings = { ...endpoint, pollIntervalS: 60 };
    const ownerA = {};
    const ownerB = {};
    const a = registry.acquire(simulator.serial, settings, ownerA);
    const b = registry.acquire(simulator.serial, settings, ownerB);
    assert.equal(a, b);
    await registry.release(simulator.serial, ownerA);
    assert.equal(registry.get(simulator.serial), a);
    await registry.release(simulator.serial, ownerB);
    assert.equal(registry.get(simulator.serial), undefined);
    await registry.destroy();
  });

  it('detects three-phase systems', async () => {
    simulator.set(60091, [2300]);
    simulator.set(60093, [2290]);
    const registry = new GatewayRegistry(timers, quiet, async () => '127.0.0.1:80');
    const probe = await registry.probe({ host: '127.0.0.1', port: PORT + 2, unitId: 1 });
    assert.equal(probe.phaseCount, 3);
    simulator.reset();
  });
});

describe('discovery', () => {
  const simulator = new AtmoceSimulator({ port: PORT + 4, host: '0.0.0.0' });

  before(async () => {
    await simulator.start();
  });

  after(async () => {
    await simulator.stop();
  });

  it('lists the /24 around Homey, without Homey, private IPv4 only', () => {
    const hosts = subnetHosts('192.168.1.20:80');
    assert.equal(hosts.length, 253);
    assert.equal(hosts.includes('192.168.1.20'), false);
    assert.equal(hosts[0], '192.168.1.1');
    assert.equal(subnetHosts('10.0.4.7').length, 253);
    assert.deepEqual(subnetHosts('8.8.8.8:80'), []);
    assert.deepEqual(subnetHosts('[fe80::1]:80'), []);
  });

  it('finds the gateway by serial and ignores hosts without it', async () => {
    const found = await scanForGateways(['127.0.0.1', '127.0.0.2', '127.0.0.3'], {
      port: PORT + 4, unitId: 1, logger: quiet, connectTimeoutMs: 300,
    });
    assert.equal(found.length, 3); // the simulator listens on all loopback addresses
    assert.deepEqual(found.map((f) => f.identity.serial), [simulator.serial, simulator.serial, simulator.serial]);
    const none = await scanForGateways(['127.0.0.1'], {
      port: PORT + 9, unitId: 1, logger: quiet, connectTimeoutMs: 300,
    });
    assert.deepEqual(none, []);
  });
});
