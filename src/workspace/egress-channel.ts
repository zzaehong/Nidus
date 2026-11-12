// Host end of the egress link: many guest TCP connections multiplexed over one
// virtio console port ("nidus.egress"). Each guest connection becomes a Duplex
// handed to the host. The guest end is scripts/vault-vm/egress-relay.py.
//
// Frame: type u8 | stream u32 BE | length u32 BE | payload
// OPEN carries the service the guest connected to: empty for the Egress Proxy
// (guest 127.0.0.1:3128), "browser" for the browser's DevTools link (guest 127.0.0.1:3129),
// "workspace" for workspace transfers (guest 127.0.0.1:3130).
// Flow control: each side may have WINDOW bytes in flight per stream and direction;
// the receiver returns credit (WINDOW frames) as its local socket consumes data.
import { Duplex } from 'node:stream';

export const FRAME = { HELLO: 0, OPEN: 1, DATA: 2, END: 3, RESET: 4, WINDOW: 5 } as const;
export const PROTOCOL_VERSION = 1;
export const WINDOW = 256 * 1024;
export const MAX_PAYLOAD = 64 * 1024;
export const MAX_STREAMS = 256;
export const SERVICES = ['egress', 'browser', 'workspace'] as const;
export type Service = typeof SERVICES[number];
const HEADER = 9;

export function encodeFrame(type: number, stream: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(HEADER);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(stream, 1);
  header.writeUInt32BE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

const credit = (bytes: number) => { const payload = Buffer.alloc(4); payload.writeUInt32BE(bytes); return payload; };

/** Splits a byte stream into frames. Throws on a malformed frame, which ends the link. */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (type: number, stream: number, payload: Buffer) => void): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= HEADER) {
      const type = this.buffer.readUInt8(0);
      const stream = this.buffer.readUInt32BE(1);
      const length = this.buffer.readUInt32BE(5);
      if (type > FRAME.WINDOW || length > MAX_PAYLOAD) throw new Error('egress_frame_invalid');
      if (this.buffer.length < HEADER + length) return;
      const payload = this.buffer.subarray(HEADER, HEADER + length);
      this.buffer = this.buffer.subarray(HEADER + length);
      onFrame(type, stream, payload);
    }
  }
}

class MuxStream extends Duplex {
  private sendCredit = WINDOW;
  private unacknowledged = 0;
  private readonly pending: { chunk: Buffer; callback: (error?: Error | null) => void }[] = [];
  private localEnded = false;
  private remoteEnded = false;
  remoteReset = false;

  constructor(readonly id: number, private readonly channel: EgressChannel) {
    super({ allowHalfOpen: true });
  }

  // --- from the guest -------------------------------------------------------

  receive(payload: Buffer): void {
    this.unacknowledged += payload.length;
    // More than the window means the guest ignored flow control.
    if (this.unacknowledged > WINDOW) { this.destroy(); return; }
    this.push(Buffer.from(payload));
  }

  grant(bytes: number): void {
    this.sendCredit += bytes;
    this.flush();
  }

  remoteEnd(): void {
    this.remoteEnded = true;
    this.push(null);
    this.settle();
  }

  // --- to the guest ---------------------------------------------------------

  override _read(): void {
    // The local consumer drained its buffer: give the guest that much room back.
    if (this.unacknowledged > 0 && !this.destroyed) {
      this.channel.send(FRAME.WINDOW, this.id, credit(this.unacknowledged));
      this.unacknowledged = 0;
    }
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.pending.push({ chunk, callback });
    this.flush();
  }

  private flush(): void {
    while (this.pending.length && this.sendCredit > 0 && !this.destroyed) {
      const head = this.pending[0]!;
      const size = Math.min(head.chunk.length, this.sendCredit, MAX_PAYLOAD);
      this.channel.send(FRAME.DATA, this.id, head.chunk.subarray(0, size));
      this.sendCredit -= size;
      head.chunk = head.chunk.subarray(size);
      if (!head.chunk.length) { this.pending.shift(); head.callback(); }
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.channel.send(FRAME.END, this.id);
    this.localEnded = true;
    callback();
    this.settle();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.remoteReset && !(this.localEnded && this.remoteEnded)) this.channel.send(FRAME.RESET, this.id);
    for (const item of this.pending.splice(0)) item.callback(new Error('egress_stream_closed'));
    this.channel.forget(this.id);
    callback(error);
  }

  /** Both directions finished: the stream is done. */
  private settle(): void {
    if (this.localEnded && this.remoteEnded) this.destroy();
  }
}

export interface EgressChannelEvents {
  /** The guest relay announced itself (first start or a restart). */
  onHello?: (version: number) => void;
  /** The link failed or broke protocol; every stream has been closed. */
  onClose?: (reason: string) => void;
}

export class EgressChannel {
  private readonly streams = new Map<number, MuxStream>();
  private readonly parser = new FrameParser();
  private closed = false;

  constructor(private readonly link: Duplex, private readonly accept: (stream: Duplex, service: Service) => void, private readonly events: EgressChannelEvents = {}) {
    link.on('data', (chunk: Buffer) => {
      try {
        this.parser.push(chunk, (type, stream, payload) => this.handle(type, stream, payload));
      } catch {
        this.close('protocol error');
      }
    });
    link.on('error', () => this.close('link error'));
    link.on('close', () => this.close('link closed'));
  }

  get openStreams(): number {
    return this.streams.size;
  }

  send(type: number, stream: number, payload?: Buffer): void {
    if (!this.closed && !this.link.destroyed) this.link.write(encodeFrame(type, stream, payload));
  }

  forget(id: number): void {
    this.streams.delete(id);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of [...this.streams.values()]) { stream.remoteReset = true; stream.destroy(); }
    this.link.destroy();
    this.events.onClose?.(reason);
  }

  private handle(type: number, id: number, payload: Buffer): void {
    if (type === FRAME.HELLO) {
      // A restarted relay has forgotten its connections; ours are stale.
      for (const stream of [...this.streams.values()]) { stream.remoteReset = true; stream.destroy(); }
      this.events.onHello?.(payload.length ? payload.readUInt8(0) : 0);
      return;
    }
    const stream = this.streams.get(id);
    if (type === FRAME.OPEN) {
      const service = (payload.length ? payload.toString('latin1') : 'egress') as Service;
      if (stream || this.streams.size >= MAX_STREAMS || !SERVICES.includes(service)) { this.send(FRAME.RESET, id); return; }
      const created = new MuxStream(id, this);
      created.on('error', () => {});
      this.streams.set(id, created);
      this.accept(created, service);
      return;
    }
    if (!stream) {
      // Late frames for a stream that is already gone are normal; answer data so the guest stops.
      if (type === FRAME.DATA) this.send(FRAME.RESET, id);
      return;
    }
    switch (type) {
      case FRAME.DATA: stream.receive(payload); break;
      case FRAME.END: stream.remoteEnd(); break;
      case FRAME.RESET: stream.remoteReset = true; stream.destroy(); break;
      case FRAME.WINDOW: if (payload.length === 4) stream.grant(payload.readUInt32BE(0)); break;
    }
  }
}
