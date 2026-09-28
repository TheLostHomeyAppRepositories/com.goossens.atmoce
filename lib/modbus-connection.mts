import net from 'node:net';

import modbusSerial from 'modbus-serial';

// modbus-serial is CommonJS (`module.exports = ModbusRTU`) while its typings declare an
// ES default export. Under NodeNext the default import is `module.exports`, i.e. the class
// that the typings expose as `.default`.
type ModbusRTUClass = (typeof modbusSerial)['default'];
type ModbusRTU = InstanceType<ModbusRTUClass>;
const ModbusClient = modbusSerial as unknown as ModbusRTUClass;

export interface Endpoint {
  host: string;
  port: number;
  unitId: number;
}

export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** modbus-serial rejects with `{ modbusCode }` for exception responses. */
export function isModbusException(err: unknown): err is { modbusCode: number; message: string } {
  return typeof err === 'object' && err !== null && typeof (err as { modbusCode?: unknown }).modbusCode === 'number';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

export const DEFAULT_PORT = 502;
export const DEFAULT_UNIT_ID = 1;
const DEFAULT_TIMEOUT_MS = 5000;
/** Detects a dead gateway/network between polls (OS-level probe, not an idle keep-alive). */
const KEEPALIVE_MS = 15_000;

/**
 * One Modbus TCP connection to one gateway.
 *
 * - Requests are serialised: one frame in flight at a time.
 * - The TCP socket is owned here (not by modbus-serial) so connect timeouts,
 *   keep-alive and close/error events are handled through public APIs. It is handed
 *   to modbus-serial with the documented `socket` option of `linkTCP`.
 * - Any I/O error drops the socket; the next request reconnects.
 */
export class ModbusConnection {

  readonly endpoint: Readonly<Endpoint>;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  private client: ModbusRTU | null = null;
  private socket: net.Socket | null = null;
  private connecting: Promise<ModbusRTU> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private connections = 0;

  constructor(endpoint: Endpoint, logger: Logger, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.endpoint = { ...endpoint };
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** Increments on every (re)connect, so callers can re-validate what they cached. */
  get connectionCount(): number {
    return this.connections;
  }

  readRegisters(start: number, length: number): Promise<number[]> {
    return this.enqueue(async (client) => {
      const result = await client.readHoldingRegisters(start, length);
      if (result.data.length !== length) {
        throw new Error(`Expected ${length} registers from ${start}, got ${result.data.length}`);
      }
      return Array.from(result.data);
    });
  }

  writeRegister(address: number, value: number): Promise<void> {
    return this.enqueue(async (client) => {
      await client.writeRegister(address, value);
    });
  }

  writeRegisters(address: number, values: number[]): Promise<void> {
    return this.enqueue(async (client) => {
      await client.writeRegisters(address, values);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue.catch(() => undefined);
    this.dropSocket('closed');
  }

  private enqueue<T>(operation: (client: ModbusRTU) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.closed) throw new Error('Connection closed');
      const client = await this.getClient();
      try {
        return await operation(client);
      } catch (err) {
        // A Modbus exception response (e.g. illegal address) leaves the socket usable;
        // anything else (timeout, reset) may have desynchronised the stream.
        if (!isModbusException(err)) this.dropSocket(errorMessage(err));
        throw err;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async getClient(): Promise<ModbusRTU> {
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<ModbusRTU> {
    const { host, port, unitId } = this.endpoint;
    const socket = new net.Socket();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, KEEPALIVE_MS);

    // The socket's own inactivity timeout doubles as connect timeout (no global timers).
    socket.setTimeout(this.timeoutMs);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error(`Timed out connecting to ${host}:${port}`)));
      socket.connect({ host, port });
    }).catch((err) => {
      socket.destroy();
      throw err;
    });
    socket.removeAllListeners('connect');
    socket.removeAllListeners('error');
    socket.removeAllListeners('timeout');
    socket.setTimeout(0);

    const client = new ModbusClient();
    await client.linkTCP(socket, { port });
    client.setID(unitId);
    // Modbus response timeout (per request), not a socket idle timeout.
    client.setTimeout(this.timeoutMs);

    socket.on('error', (err) => this.dropSocket(err.message));
    socket.on('close', () => this.dropSocket('socket closed'));

    this.socket = socket;
    this.client = client;
    this.connections += 1;
    this.logger.log(`Connected to ${host}:${port} (unit ${unitId})`);
    return client;
  }

  private dropSocket(reason: string): void {
    if (!this.socket) return;
    const { socket } = this;
    this.socket = null;
    this.client = null;
    socket.removeAllListeners('close');
    socket.destroy();
    this.logger.log(`Disconnected from ${this.endpoint.host}:${this.endpoint.port}: ${reason}`);
  }

}
