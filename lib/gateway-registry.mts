import { type FoundGateway, scanForGateways, subnetHosts } from './discovery.mts';
import { AtmoceGateway, type Timers, readIdentity } from './gateway.mts';
import {
  type Endpoint,
  type Logger,
  ModbusConnection,
} from './modbus-connection.mts';
import { BLOCKS, type Identity, decodePhases } from './registers.mts';

export interface ProbeResult {
  identity: Identity;
  /** 3 when the gateway reports a voltage on phase B or C (MC100-T), otherwise 1. */
  phaseCount: 1 | 3;
}

export interface ConnectionSettings extends Endpoint {
  pollIntervalS: number;
}

function phaseCount(phases: ReadonlyArray<{ voltageV: number }>): 1 | 3 {
  return phases.slice(1).some((phase) => phase.voltageV > 0) ? 3 : 1;
}

export function toEndpoint(settings: Endpoint): Endpoint {
  return { host: settings.host, port: settings.port, unitId: settings.unitId };
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.host === b.host && a.port === b.port && a.unitId === b.unitId;
}

function prefixed(logger: Logger, prefix: string): Logger {
  return {
    log: (...args) => logger.log(prefix, ...args),
    error: (...args) => logger.error(prefix, ...args),
  };
}

interface Entry {
  gateway: AtmoceGateway;
  owners: Set<object>;
  /** Last time the network was searched for this gateway's new address. */
  relocatedAt: number;
  relocating: Promise<Endpoint | null> | null;
}

/** Minimum time between two network searches for the same gateway. */
const RELOCATE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Keeps one AtmoceGateway (one Modbus TCP connection) per gateway serial, shared by the
 * solar, battery and grid devices of that gateway. Lives on the App.
 */
export class GatewayRegistry {

  private readonly entries = new Map<string, Entry>();
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly localAddress: () => Promise<string>;
  private readonly onGateway: ((gateway: AtmoceGateway) => void) | undefined;

  /**
   * `localAddress` is `homey.cloud.getLocalAddress`, used to find the LAN to search.
   * `onGateway` receives every new gateway before it starts polling (to listen to its events).
   */
  constructor(
    timers: Timers,
    logger: Logger,
    localAddress: () => Promise<string>,
    onGateway?: (gateway: AtmoceGateway) => void,
  ) {
    this.timers = timers;
    this.logger = logger;
    this.localAddress = localAddress;
    this.onGateway = onGateway;
  }

  acquire(serial: string, settings: ConnectionSettings, owner: object): AtmoceGateway {
    let entry = this.entries.get(serial);
    if (!entry) {
      const gateway = new AtmoceGateway({
        endpoint: toEndpoint(settings),
        pollIntervalMs: settings.pollIntervalS * 1000,
        expectedSerial: serial,
        timers: this.timers,
        logger: prefixed(this.logger, `[${serial}]`),
      });
      entry = {
        gateway, owners: new Set(), relocatedAt: 0, relocating: null,
      };
      this.onGateway?.(gateway);
      this.entries.set(serial, entry);
      gateway.start();
    }
    entry.owners.add(owner);
    return entry.gateway;
  }

  async release(serial: string, owner: object): Promise<void> {
    const entry = this.entries.get(serial);
    if (!entry) return;
    entry.owners.delete(owner);
    if (entry.owners.size > 0) return;
    this.entries.delete(serial);
    await entry.gateway.stop();
  }

  get(serial: string): AtmoceGateway | undefined {
    return this.entries.get(serial)?.gateway;
  }

  /** All gateways in use, sorted by serial. */
  list(): AtmoceGateway[] {
    return [...this.entries.values()].map(({ gateway }) => gateway).sort((a, b) => a.serial.localeCompare(b.serial));
  }

  /** A known gateway, for pre-filling the pairing form. */
  anyEndpoint(): Endpoint | undefined {
    const first = this.entries.values().next();
    return first.done ? undefined : first.value.gateway.endpoint;
  }

  /**
   * Reads the identity and phase count of the gateway at `endpoint`. Reuses a running
   * connection to the same address, so pairing never opens a second connection to a
   * gateway in use.
   */
  async probe(endpoint: Endpoint): Promise<ProbeResult> {
    for (const { gateway } of this.entries.values()) {
      if (sameEndpoint(gateway.endpoint, endpoint) && gateway.isAvailable && gateway.identity && gateway.snapshot) {
        return { identity: gateway.identity, phaseCount: phaseCount(gateway.snapshot.phases.phases) };
      }
    }
    const connection = new ModbusConnection(endpoint, prefixed(this.logger, '[probe]'));
    try {
      const identity = await readIdentity(connection);
      const phases = decodePhases(await connection.readRegisters(BLOCKS.phases.start, BLOCKS.phases.length));
      return { identity, phaseCount: phaseCount(phases.phases) };
    } finally {
      await connection.close();
    }
  }

  /** Atmoce gateways on Homey's /24 subnet (for pairing). Gateways in use answer from memory. */
  async discover(port: number, unitId: number): Promise<FoundGateway[]> {
    const hosts = subnetHosts(await this.localAddress());
    const known = new Map<string, FoundGateway>();
    for (const { gateway } of this.entries.values()) {
      const { host } = gateway.endpoint;
      if (gateway.identity && gateway.isAvailable) known.set(host, { host, identity: gateway.identity });
    }
    const scanned = await scanForGateways(hosts.filter((host) => !known.has(host)), {
      port, unitId, logger: prefixed(this.logger, '[discovery]'),
    });
    return [...known.values(), ...scanned].sort((a, b) => a.identity.serial.localeCompare(b.identity.serial));
  }

  /**
   * Searches the network for a gateway that stopped answering at its address (e.g. a new
   * DHCP lease) and moves its connection there. Rate-limited and single-flight per gateway.
   * Resolves the new endpoint, or null when it was not found (or searched too recently).
   */
  relocate(serial: string): Promise<Endpoint | null> {
    const entry = this.entries.get(serial);
    if (!entry) return Promise.resolve(null);
    if (entry.relocating) return entry.relocating;
    if (Date.now() - entry.relocatedAt < RELOCATE_INTERVAL_MS) return Promise.resolve(null);
    entry.relocatedAt = Date.now();
    entry.relocating = this.findNewAddress(entry).finally(() => {
      entry.relocating = null;
    });
    return entry.relocating;
  }

  private async findNewAddress(entry: Entry): Promise<Endpoint | null> {
    const { gateway } = entry;
    const current = gateway.endpoint;
    this.logger.log(`[${gateway.serial}] not answering at ${current.host}; searching the network`);
    const hosts = subnetHosts(await this.localAddress()).filter((host) => host !== current.host);
    const found = await scanForGateways(hosts, {
      port: current.port, unitId: current.unitId, logger: prefixed(this.logger, '[discovery]'),
    });
    const match = found.find((candidate) => candidate.identity.serial === gateway.serial);
    if (!match) {
      this.logger.log(`[${gateway.serial}] not found on the network`);
      return null;
    }
    const endpoint = { ...current, host: match.host };
    this.logger.log(`[${gateway.serial}] found at ${match.host}`);
    await gateway.reconfigure(endpoint, gateway.pollIntervalMs);
    return endpoint;
  }

  async destroy(): Promise<void> {
    const gateways = [...this.entries.values()].map(({ gateway }) => gateway);
    this.entries.clear();
    await Promise.all(gateways.map((gateway) => gateway.stop()));
  }

}
