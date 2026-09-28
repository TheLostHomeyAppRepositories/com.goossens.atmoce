import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';

import { CONNECTION_ALERT_DELAY_MS, type GatewayAlert, GatewayAlerts } from '../lib/gateway-alerts.mts';
import type { Identity } from '../lib/registers.mts';

class FakeGateway extends EventEmitter {
  serial = 'SN1';
  endpoint = { host: '192.168.1.50', port: 502, unitId: 1 };
  isAvailable = true;
  lastError: string | null = null;
  unavailableSince: number | null = null;

  goDown(error: string): void {
    this.isAvailable = false;
    this.lastError = error;
    this.unavailableSince = Date.now();
    this.emit('unavailable', error);
  }

  comeBack(): void {
    this.isAvailable = true;
    this.lastError = null;
    this.unavailableSince = null;
    this.emit('available');
  }
}

type Callback = () => void;

/** Manual timers: `run()` fires everything pending. */
function fakeTimers() {
  const pending = new Map<number, Callback>();
  let next = 0;
  return {
    pending,
    lastDelayMs: -1,
    setTimeout(callback: Callback, ms: number): unknown {
      this.lastDelayMs = ms;
      next += 1;
      pending.set(next, callback);
      return next;
    },
    clearTimeout(timer: unknown): void {
      pending.delete(timer as number);
    },
    run(): void {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback();
    },
  };
}

const identity = (firmwareVersion: string) => ({ serial: 'SN1', firmwareVersion } as Identity);

describe('GatewayAlerts', () => {
  let timers: ReturnType<typeof fakeTimers>;
  let gateway: FakeGateway;
  let alerts: GatewayAlert[];
  let firmware: Map<string, string>;

  beforeEach(() => {
    timers = fakeTimers();
    gateway = new FakeGateway();
    alerts = [];
    firmware = new Map();
    new GatewayAlerts({
      timers,
      firmware: { get: (serial) => firmware.get(serial) ?? null, set: (serial, version) => firmware.set(serial, version) },
      alert: (_serial, alert) => alerts.push(alert),
    }).watch(gateway);
  });

  it('stays quiet when the gateway comes back before the delay', () => {
    gateway.goDown('Timed out');
    gateway.comeBack();
    timers.run();
    assert.deepEqual(alerts, []);
  });

  it('reports a long outage once, then the recovery', () => {
    gateway.goDown('Timed out');
    gateway.emit('unavailable', 'Timed out');
    assert.equal(timers.pending.size, 1);
    timers.run();
    assert.equal(alerts.length, 1);
    const [lost] = alerts;
    assert.equal(lost?.kind, 'connection_lost');
    assert.ok(lost?.kind === 'connection_lost' && lost.error === 'Timed out' && lost.host === '192.168.1.50');
    gateway.comeBack();
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1]?.kind, 'connection_restored');
  });

  it('does not report when the gateway answered again by the time the delay ends', () => {
    gateway.goDown('Timed out');
    gateway.isAvailable = true;
    timers.run();
    assert.deepEqual(alerts, []);
  });

  it('waits the delay counted from the start of the outage', () => {
    gateway.goDown('Timed out');
    assert.ok(timers.lastDelayMs > CONNECTION_ALERT_DELAY_MS - 1000 && timers.lastDelayMs <= CONNECTION_ALERT_DELAY_MS);
    timers.pending.clear();
    gateway.comeBack();
    gateway.unavailableSince = Date.now() - 4 * 60_000;
    gateway.isAvailable = false;
    gateway.emit('unavailable', 'Timed out');
    assert.ok(timers.lastDelayMs <= CONNECTION_ALERT_DELAY_MS - 4 * 60_000);
  });

  it('reports a firmware change, not the first firmware seen', () => {
    gateway.emit('identity', identity('01.01.00.23.10'));
    assert.deepEqual(alerts, []);
    gateway.emit('identity', identity('01.01.00.23.10'));
    gateway.emit('identity', identity('01.01.00.29.03'));
    assert.deepEqual(alerts, [{ kind: 'firmware_updated', previous: '01.01.00.23.10', current: '01.01.00.29.03' }]);
    assert.equal(firmware.get('SN1'), '01.01.00.29.03');
  });

  it('cancels a pending alert when the gateway is released', () => {
    gateway.goDown('Timed out');
    gateway.emit('stop');
    assert.equal(timers.pending.size, 0);
  });
});
