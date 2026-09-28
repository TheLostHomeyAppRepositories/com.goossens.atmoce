import net from 'node:net';

import { readIdentity } from './gateway.mts';
import { type Logger, ModbusConnection } from './modbus-connection.mts';
import type { Identity } from './registers.mts';

export interface FoundGateway {
  host: string;
  identity: Identity;
}

export interface ScanOptions {
  port: number;
  unitId: number;
  logger: Logger;
  /** TCP connect timeout per host. */
  connectTimeoutMs?: number;
  /** Hosts probed at the same time. */
  concurrency?: number;
}

/**
 * The /24 subnet around Homey's own LAN address, without Homey itself.
 * `localAddress` is what `homey.cloud.getLocalAddress()` returns, e.g. "192.168.1.20:80".
 * Returns [] for anything that is not a private IPv4 address.
 */
export function subnetHosts(localAddress: string): string[] {
  const ip = localAddress.split(':')[0] ?? '';
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return [];
  const [a, b] = parts as [number, number, number, number];
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!isPrivate) return [];
  const prefix = parts.slice(0, 3).join('.');
  return Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((host) => host !== ip);
}

function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function identify(host: string, options: ScanOptions): Promise<FoundGateway | null> {
  const connection = new ModbusConnection({ host, port: options.port, unitId: options.unitId }, options.logger, 2500);
  try {
    return { host, identity: await readIdentity(connection) };
  } catch {
    return null; // another Modbus device, or not an Atmoce gateway
  } finally {
    await connection.close();
  }
}

/**
 * Finds Atmoce gateways among `hosts`: a TCP connect to the Modbus port, then the identity
 * block (serial number) for hosts that accept. Only reads; never writes.
 */
export async function scanForGateways(hosts: readonly string[], options: ScanOptions): Promise<FoundGateway[]> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 700;
  const concurrency = options.concurrency ?? 32;
  const open: string[] = [];
  const queue = [...hosts];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let host = queue.shift(); host !== undefined; host = queue.shift()) {
      if (await portOpen(host, options.port, connectTimeoutMs)) open.push(host);
    }
  }));
  const found: FoundGateway[] = [];
  for (const host of open) {
    const gateway = await identify(host, options);
    if (gateway) found.push(gateway);
  }
  return found.sort((x, y) => x.identity.serial.localeCompare(y.identity.serial));
}
