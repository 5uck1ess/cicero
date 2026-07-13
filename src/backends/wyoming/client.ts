import type { Socket } from "bun";
import type { WyomingEvent, WyomingHeader } from "./types";

export interface WyomingClientOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  /** Maximum newline-delimited JSON header size. Defaults to 64 KiB. */
  maxHeaderBytes?: number;
  /** Maximum extra JSON data segment size. Defaults to 1 MiB. */
  maxDataBytes?: number;
  /** Maximum binary payload size for one event. Defaults to 64 MiB. */
  maxPayloadBytes?: number;
  /** Maximum events retained while no receiver is waiting. Defaults to 256. */
  maxQueuedEvents?: number;
  /** Maximum framed bytes retained in the event queue. Defaults to 128 MiB. */
  maxQueuedBytes?: number;
}

/** The subset of WyomingClient the providers depend on (enables test mocking). */
export interface WyomingTransport {
  send(event: WyomingEvent, payload?: Uint8Array): Promise<void>;
  receive(timeoutMs?: number): Promise<WyomingEvent>;
  receiveOfType(type: string, timeoutMs?: number): Promise<WyomingEvent>;
  describe(): Promise<WyomingEvent>;
  close(): void;
}

interface Waiter {
  deliver(event: WyomingEvent): void;
  reject(error: Error): void;
}

interface QueuedEvent {
  event: WyomingEvent;
  frameBytes: number;
}

const NEWLINE = 0x0a;
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_DATA_BYTES = 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_EVENTS = 256;
const DEFAULT_MAX_QUEUED_BYTES = 128 * 1024 * 1024;

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`);
}

function contextualError(context: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * TCP client for the Wyoming voice protocol. Frames newline-delimited JSON
 * headers plus optional extra-JSON and binary payloads, and exposes an
 * async `receive()` queue so callers can await events one at a time.
 */
export class WyomingClient implements WyomingTransport {
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private readBuffer = new Uint8Array(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly waiters: Waiter[] = [];
  private readonly events: QueuedEvent[] = [];
  private queuedBytes = 0;
  private failure: Error | null = null;
  private intentionallyClosed = false;
  private readonly maxHeaderBytes: number;
  private readonly maxDataBytes: number;
  private readonly maxPayloadBytes: number;
  private readonly maxQueuedEvents: number;
  private readonly maxQueuedBytes: number;

  constructor(private readonly opts: WyomingClientOptions) {
    this.maxHeaderBytes = positiveLimit(
      opts.maxHeaderBytes,
      DEFAULT_MAX_HEADER_BYTES,
      "maxHeaderBytes",
    );
    this.maxDataBytes = positiveLimit(opts.maxDataBytes, DEFAULT_MAX_DATA_BYTES, "maxDataBytes");
    this.maxPayloadBytes = positiveLimit(
      opts.maxPayloadBytes,
      DEFAULT_MAX_PAYLOAD_BYTES,
      "maxPayloadBytes",
    );
    this.maxQueuedEvents = positiveLimit(
      opts.maxQueuedEvents,
      DEFAULT_MAX_QUEUED_EVENTS,
      "maxQueuedEvents",
    );
    this.maxQueuedBytes = positiveLimit(
      opts.maxQueuedBytes,
      DEFAULT_MAX_QUEUED_BYTES,
      "maxQueuedBytes",
    );
  }

  async connect(): Promise<void> {
    try {
      if (this.socket) return;
      if (this.connecting) return await this.connecting;
      this.failure = null;
      this.intentionallyClosed = false;
      this.connecting = Bun.connect({
        hostname: this.opts.host,
        port: this.opts.port,
        socket: {
          data: (_sock, data) => this.onData(data),
          close: () => this.onSocketClosed(),
          error: (_sock, error) => this.fail(asError(error, "Wyoming socket failed"), false),
        },
      }).then((sock) => {
        this.socket = sock;
      }).finally(() => {
        this.connecting = null;
      });
      await this.connecting;
    } catch (error: unknown) {
      throw asError(error, "Wyoming connection failed");
    }
  }

  private onData(chunk: Uint8Array): void {
    if (this.failure) return;
    try {
      const merged = new Uint8Array(this.readBuffer.length + chunk.length);
      merged.set(this.readBuffer);
      merged.set(chunk, this.readBuffer.length);
      this.readBuffer = merged;
      this.processBuffer();
    } catch (error: unknown) {
      this.fail(asError(error, "Malformed Wyoming stream"), true);
    }
  }

  private processBuffer(): void {
    for (;;) {
      const nl = this.readBuffer.indexOf(NEWLINE);
      if (nl === -1) {
        if (this.readBuffer.byteLength > this.maxHeaderBytes) {
          throw new RangeError(`Wyoming header exceeds ${this.maxHeaderBytes} bytes`);
        }
        return;
      }
      if (nl > this.maxHeaderBytes) {
        throw new RangeError(`Wyoming header exceeds ${this.maxHeaderBytes} bytes`);
      }

      let parsedHeader: unknown;
      try {
        parsedHeader = JSON.parse(this.decoder.decode(this.readBuffer.subarray(0, nl)));
      } catch (error: unknown) {
        throw contextualError("Wyoming header is not valid UTF-8 JSON", error);
      }
      const header = this.validateHeader(parsedHeader);

      const dataLen = this.frameLength(header.data_length, this.maxDataBytes, "data_length");
      const payloadLen = this.frameLength(
        header.payload_length,
        this.maxPayloadBytes,
        "payload_length",
      );
      const bodyStart = nl + 1;
      if (this.readBuffer.length - bodyStart < dataLen + payloadLen) return; // wait for more

      let offset = bodyStart;
      const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (header.data) Object.assign(data, header.data);
      if (dataLen > 0) {
        let extraData: unknown;
        try {
          extraData = JSON.parse(
            this.decoder.decode(this.readBuffer.subarray(offset, offset + dataLen)),
          );
        } catch (error: unknown) {
          throw contextualError("Wyoming extra data is not valid UTF-8 JSON", error);
        }
        if (!isRecord(extraData)) throw new TypeError("Wyoming extra data must be a JSON object");
        Object.assign(data, extraData);
        offset += dataLen;
      }

      let payload: Uint8Array | undefined;
      if (payloadLen > 0) {
        payload = this.readBuffer.slice(offset, offset + payloadLen);
        offset += payloadLen;
      }

      this.readBuffer = this.readBuffer.slice(offset);
      if (!this.emit(
        { type: header.type, data, payload, version: header.version },
        offset,
      )) return;
    }
  }

  private validateHeader(value: unknown): WyomingHeader {
    if (!isRecord(value)) throw new TypeError("Wyoming header must be a JSON object");
    if (typeof value.type !== "string" || value.type.trim().length === 0) {
      throw new TypeError("Wyoming header type must be a non-empty string");
    }
    if (value.data !== undefined && value.data !== null && !isRecord(value.data)) {
      throw new TypeError("Wyoming header data must be a JSON object");
    }
    if (value.version !== undefined && typeof value.version !== "string") {
      throw new TypeError("Wyoming header version must be a string");
    }
    return value as unknown as WyomingHeader;
  }

  private frameLength(value: number | null | undefined, max: number, name: string): number {
    if (value === undefined || value === null) return 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Wyoming ${name} must be a non-negative safe integer`);
    }
    if (value > max) throw new RangeError(`Wyoming ${name} exceeds ${max} bytes`);
    return value;
  }

  private emit(event: WyomingEvent, frameBytes: number): boolean {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.deliver(event);
      return true;
    }
    if (
      this.events.length >= this.maxQueuedEvents ||
      this.queuedBytes + frameBytes > this.maxQueuedBytes
    ) {
      this.fail(
        new RangeError(
          `Wyoming event queue exceeds ${this.maxQueuedEvents} events or ${this.maxQueuedBytes} bytes`,
        ),
        true,
      );
      return false;
    }
    this.events.push({ event, frameBytes });
    this.queuedBytes += frameBytes;
    return true;
  }

  private onSocketClosed(): void {
    this.socket = null;
    if (!this.intentionallyClosed && !this.failure) {
      this.fail(new Error("Wyoming connection closed before the requested event"), false);
    }
  }

  private fail(error: Error, discardEvents: boolean): void {
    if (!this.failure) this.failure = error;
    this.readBuffer = new Uint8Array(0);
    if (discardEvents) {
      this.events.length = 0;
      this.queuedBytes = 0;
    }
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(this.failure);
    const socket = this.socket;
    this.socket = null;
    socket?.end();
  }

  async send(event: WyomingEvent, payload?: Uint8Array): Promise<void> {
    try {
      await this.connect();
      const pl = payload ?? event.payload;
      const header: WyomingHeader = { type: event.type, data: event.data ?? {} };
      if (pl) header.payload_length = pl.byteLength;
      const socket = this.socket;
      if (!socket) throw new Error("Wyoming connection closed before send");
      socket.write(JSON.stringify(header) + "\n");
      if (pl) socket.write(pl);
    } catch (error: unknown) {
      throw asError(error, "Wyoming send failed");
    }
  }

  /** Resolve with the next event, or reject after `timeoutMs`. */
  async receive(timeoutMs: number = this.opts.timeoutMs ?? 10000): Promise<WyomingEvent> {
    try {
      const queued = this.events.shift();
      if (queued) {
        this.queuedBytes -= queued.frameBytes;
        return queued.event;
      }
      if (this.failure) throw this.failure;
      return await new Promise<WyomingEvent>((resolve, reject) => {
        const waiter: Waiter = { deliver: () => {}, reject: () => {} };
        const timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`Wyoming receive timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiter.deliver = (event) => {
          clearTimeout(timer);
          resolve(event);
        };
        waiter.reject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        this.waiters.push(waiter);
      });
    } catch (error: unknown) {
      throw asError(error, "Wyoming receive failed");
    }
  }

  /** Receive events until one matches `type` (ignoring others), or timeout. */
  async receiveOfType(type: string, timeoutMs?: number): Promise<WyomingEvent> {
    const budgetMs = timeoutMs ?? this.opts.timeoutMs ?? 10000;
    const deadline = Date.now() + budgetMs;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`Wyoming receive timed out after ${budgetMs}ms waiting for ${type}`);
        }
        const event = await this.receive(remaining);
        if (event.type === type) return event;
      }
    } catch (error: unknown) {
      throw asError(error, `Wyoming receive failed while waiting for ${type}`);
    }
  }

  async describe(): Promise<WyomingEvent> {
    try {
      await this.send({ type: "describe", data: {} });
      return await this.receiveOfType("info");
    } catch (error: unknown) {
      throw asError(error, "Wyoming describe failed");
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    const closed = new Error("Wyoming client closed");
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(closed);
    this.events.length = 0;
    this.queuedBytes = 0;
    this.readBuffer = new Uint8Array(0);
    this.failure = closed;
    this.socket?.end();
    this.socket = null;
  }
}
