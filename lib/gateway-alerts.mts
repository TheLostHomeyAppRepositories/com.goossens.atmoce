import type { EventEmitter } from 'node:events';

import type { AtmoceGateway, Timers } from './gateway.mts';
import type { Identity } from './registers.mts';

/**
 * A gateway stays quiet this long before "connection lost" is reported: single failed polls,
 * a Wi-Fi hiccup or a gateway reboot (e.g. for a firmware update) do not need an alarm.
 */
export const CONNECTION_ALERT_DELAY_MS = 10 * 60 * 1000;

export type GatewayAlert =
  | { kind: 'connection_lost'; host: string; port: number; error: string; sinceMs: number }
  | { kind: 'connection_restored'; host: string; port: number; downMs: number }
  | { kind: 'firmware_updated'; previous: string; current: string };

type WatchedGateway = Pick<AtmoceGateway, 'serial' | 'endpoint' | 'isAvailable' | 'lastError' | 'unavailableSince'> & {
  on(event: string, listener: Parameters<EventEmitter['on']>[1]): unknown;
};

export interface GatewayAlertOptions {
  timers: Timers;
  /** Last firmware seen per gateway, persisted by the app so updates are noticed across restarts. */
  firmware: { get(serial: string): string | null; set(serial: string, version: string): void };
  alert(serial: string, alert: GatewayAlert): void;
}

interface State {
  timer: unknown;
  /** Start of the outage; set while the gateway is unavailable. */
  since: number | null;
  /** "Connection lost" was sent; "restored" follows when the gateway answers again. */
  reported: boolean;
}

/**
 * Timeline alerts about a gateway itself, once per gateway however many devices it has.
 * Atmoce updates gateway firmware remotely without telling the owner, so a firmware change
 * is reported too.
 */
export class GatewayAlerts {

  private readonly options: GatewayAlertOptions;

  constructor(options: GatewayAlertOptions) {
    this.options = options;
  }

  watch(gateway: WatchedGateway): void {
    const state: State = { timer: null, since: null, reported: false };
    gateway.on('unavailable', () => this.onUnavailable(gateway, state));
    gateway.on('available', () => this.onAvailable(gateway, state));
    gateway.on('identity', (identity: Identity) => this.onIdentity(gateway, identity));
    gateway.on('stop', () => this.clearTimer(state));
  }

  private onUnavailable(gateway: WatchedGateway, state: State): void {
    if (state.timer !== null || state.reported) return;
    const since = gateway.unavailableSince ?? Date.now();
    state.since = since;
    const delay = Math.max(0, since + CONNECTION_ALERT_DELAY_MS - Date.now());
    state.timer = this.options.timers.setTimeout(() => {
      state.timer = null;
      if (gateway.isAvailable) return;
      state.reported = true;
      const { host, port } = gateway.endpoint;
      this.options.alert(gateway.serial, {
        kind: 'connection_lost', host, port, error: gateway.lastError ?? '?', sinceMs: Date.now() - since,
      });
    }, delay);
  }

  private onAvailable(gateway: WatchedGateway, state: State): void {
    this.clearTimer(state);
    const { since, reported } = state;
    state.since = null;
    state.reported = false;
    if (!reported || since === null) return;
    const { host, port } = gateway.endpoint;
    this.options.alert(gateway.serial, {
      kind: 'connection_restored', host, port, downMs: Date.now() - since,
    });
  }

  private onIdentity(gateway: WatchedGateway, identity: Identity): void {
    const previous = this.options.firmware.get(gateway.serial);
    const current = identity.firmwareVersion;
    if (previous === current) return;
    this.options.firmware.set(gateway.serial, current);
    if (previous) this.options.alert(gateway.serial, { kind: 'firmware_updated', previous, current });
  }

  private clearTimer(state: State): void {
    if (state.timer === null) return;
    this.options.timers.clearTimeout(state.timer);
    state.timer = null;
  }

}
