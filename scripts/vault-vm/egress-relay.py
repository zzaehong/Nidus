"""Guest end of the egress link (host end: src/workspace/egress-channel.ts).

Listens on 127.0.0.1:3128 and carries each TCP connection over the "nidus.egress"
virtio console port to the host's Egress Proxy. The VM has no network device; this
port is its only way out, and the host decides what may pass.

127.0.0.1:3129 is the browser's DevTools link: the browser bridge connects there and the
host drives Chromium and receives its screen through that stream. The OPEN frame names
the service ("browser"); an empty name means the Egress Proxy.
"""
import asyncio, os, pathlib, queue, struct, sys, threading, time

HELLO, OPEN, DATA, END, RESET, WINDOW = range(6)
VERSION = 1
CREDIT = 256 * 1024
MAX_PAYLOAD = 64 * 1024
MAX_STREAMS = 256
HEADER = struct.Struct('>BII')


def find_port():
    for entry in pathlib.Path('/sys/class/virtio-ports').glob('*'):
        try:
            if (entry / 'name').read_text().strip() == 'nidus.egress':
                return '/dev/' + entry.name
        except OSError:
            pass
    return None


class Stream:
    def __init__(self, sid, writer):
        self.sid = sid
        self.writer = writer
        self.credit = CREDIT
        self.room = asyncio.Event()
        self.done = asyncio.Event()
        self.local_ended = False
        self.remote_ended = False
        self.reset = False

    def finish(self):
        self.reset = True
        self.room.set()
        self.done.set()
        self.writer.close()


class Relay:
    def __init__(self, device):
        self.fd = os.open(device, os.O_RDWR)
        self.outbox = queue.Queue()
        self.streams = {}
        self.next_id = 1
        self.loop = None

    def send(self, kind, sid, payload=b''):
        self.outbox.put(HEADER.pack(kind, sid, len(payload)) + payload)

    # A virtio console port reports "host not connected" (empty reads, failed writes)
    # for short moments under load. That is not the end of the link: wait and retry.
    # Only a long silence counts as the host going away.
    GIVE_UP = 30.0

    def writer_thread(self):
        while True:
            data = self.outbox.get()
            view = memoryview(data)
            stalled = None
            while view:
                try:
                    view = view[os.write(self.fd, view):]
                    stalled = None
                except OSError:
                    stalled = stalled or time.monotonic()
                    if time.monotonic() - stalled > self.GIVE_UP:
                        os._exit(5)
                    time.sleep(0.01)

    def reader_thread(self):
        buffer = bytearray()
        stalled = None
        while True:
            try:
                chunk = os.read(self.fd, 262144)
            except OSError:
                chunk = b''
            if not chunk:
                stalled = stalled or time.monotonic()
                if time.monotonic() - stalled > self.GIVE_UP:
                    os._exit(3)
                time.sleep(0.01)
                continue
            stalled = None
            buffer += chunk
            while len(buffer) >= HEADER.size:
                kind, sid, length = HEADER.unpack_from(buffer)
                if kind > WINDOW or length > MAX_PAYLOAD:
                    os._exit(4)
                if len(buffer) < HEADER.size + length:
                    break
                payload = bytes(buffer[HEADER.size:HEADER.size + length])
                del buffer[:HEADER.size + length]
                self.loop.call_soon_threadsafe(self.handle, kind, sid, payload)

    def handle(self, kind, sid, payload):
        stream = self.streams.get(sid)
        if stream is None:
            return
        if kind == DATA:
            stream.writer.write(payload)
            asyncio.ensure_future(self.acknowledge(stream, len(payload)))
        elif kind == WINDOW and len(payload) == 4:
            stream.credit += struct.unpack('>I', payload)[0]
            stream.room.set()
        elif kind == END:
            stream.remote_ended = True
            if stream.writer.can_write_eof():
                stream.writer.write_eof()
            if stream.local_ended:
                stream.done.set()
        elif kind == RESET:
            stream.finish()

    async def acknowledge(self, stream, size):
        # Return credit only once the local client has actually taken the data.
        try:
            await stream.writer.drain()
        except (ConnectionError, OSError):
            return
        if not stream.reset:
            self.send(WINDOW, stream.sid, struct.pack('>I', size))

    def allocate(self):
        for _ in range(MAX_STREAMS * 4):
            sid = self.next_id
            self.next_id = self.next_id % 0xFFFFFFF0 + 1
            if sid not in self.streams:
                return sid
        return None

    async def serve(self, reader, writer, service=b''):
        sid = self.allocate() if len(self.streams) < MAX_STREAMS else None
        if sid is None:
            writer.close()
            return
        stream = Stream(sid, writer)
        self.streams[sid] = stream
        self.send(OPEN, sid, service)
        try:
            while not stream.reset:
                data = await reader.read(MAX_PAYLOAD)
                if not data:
                    self.send(END, sid)
                    stream.local_ended = True
                    if stream.remote_ended:
                        stream.done.set()
                    break
                while data and not stream.reset:
                    while stream.credit <= 0 and not stream.reset:
                        stream.room.clear()
                        await stream.room.wait()
                    if stream.reset:
                        break
                    size = min(len(data), stream.credit, MAX_PAYLOAD)
                    self.send(DATA, sid, data[:size])
                    stream.credit -= size
                    data = data[size:]
            await stream.done.wait()
        except (ConnectionError, OSError):
            if not stream.reset:
                self.send(RESET, sid)
        finally:
            self.streams.pop(sid, None)
            writer.close()

    async def run(self):
        self.loop = asyncio.get_running_loop()
        threading.Thread(target=self.writer_thread, daemon=True).start()
        threading.Thread(target=self.reader_thread, daemon=True).start()
        self.send(HELLO, 0, bytes([VERSION]))
        egress = await asyncio.start_server(self.serve, '127.0.0.1', 3128, limit=MAX_PAYLOAD)
        browser = await asyncio.start_server(lambda r, w: self.serve(r, w, b'browser'), '127.0.0.1', 3129, limit=MAX_PAYLOAD)
        async with egress, browser:
            await asyncio.gather(egress.serve_forever(), browser.serve_forever())


if __name__ == '__main__':
    device = find_port()
    if device is None:
        sys.exit(2)
    asyncio.run(Relay(device).run())
