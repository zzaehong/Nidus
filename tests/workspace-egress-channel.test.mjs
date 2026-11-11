import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { EgressChannel, FRAME, FrameParser, WINDOW, MAX_STREAMS, encodeFrame } from '../dist/workspace/egress-channel.js';
import { EgressProxy, EgressRules } from '../dist/workspace/egress.js';

// A real socket pair stands in for the virtio console port; the test plays the guest relay.
async function link(t, accept, events) {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const guest = connect(server.address().port, '127.0.0.1');
  const [host] = await once(server, 'connection');
  const channel = new EgressChannel(host, accept, events);
  const frames = [];
  const parser = new FrameParser();
  const waiters = [];
  guest.on('data', chunk => parser.push(chunk, (type, stream, payload) => {
    frames.push({ type, stream, payload: Buffer.from(payload) });
    for (const waiter of waiters.splice(0)) waiter();
  }));
  // Re-check on every frame, and every 10 ms for conditions that send nothing back.
  const until = async predicate => { while (!predicate()) await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 10); }); };
  const send = (type, stream, payload) => guest.write(encodeFrame(type, stream, payload));
  t.after(() => { guest.destroy(); server.close(); });
  return { channel, guest, frames, until, send };
}

const dataTo = (frames, stream) => Buffer.concat(frames.filter(f => f.type === FRAME.DATA && f.stream === stream).map(f => f.payload)).toString();

test('streams carry data both ways and close cleanly', async t => {
  const { channel, frames, until, send } = await link(t, stream => { stream.on('data', d => stream.write(`echo:${d}`)); stream.on('end', () => stream.end()); });
  send(FRAME.OPEN, 7);
  send(FRAME.DATA, 7, Buffer.from('hello'));
  await until(() => dataTo(frames, 7) === 'echo:hello');
  send(FRAME.END, 7);
  await until(() => frames.some(f => f.type === FRAME.END && f.stream === 7));
  await until(() => channel.openStreams === 0);
  assert.ok(!frames.some(f => f.type === FRAME.RESET), 'a clean close sends no reset');
});

test('flow control: the host waits for credit and returns credit as it consumes', async t => {
  const big = Buffer.alloc(WINDOW + 100_000, 'x');
  let received = 0;
  const { frames, until, send } = await link(t, stream => { stream.write(big); stream.on('data', d => { received += d.length; }); });
  send(FRAME.OPEN, 1);
  await until(() => frames.filter(f => f.type === FRAME.DATA).reduce((n, f) => n + f.payload.length, 0) === WINDOW);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(frames.filter(f => f.type === FRAME.DATA).reduce((n, f) => n + f.payload.length, 0), WINDOW, 'no more than the window without credit');
  const credit = Buffer.alloc(4); credit.writeUInt32BE(200_000);
  send(FRAME.WINDOW, 1, credit);
  await until(() => frames.filter(f => f.type === FRAME.DATA).reduce((n, f) => n + f.payload.length, 0) === big.length);
  assert.ok(frames.every(f => f.type !== FRAME.DATA || f.payload.length <= 64 * 1024));

  send(FRAME.DATA, 1, Buffer.alloc(1000));
  await until(() => frames.some(f => f.type === FRAME.WINDOW && f.stream === 1));
  assert.equal(received, 1000);
});

test('a guest that ignores flow control is reset', async t => {
  const { frames, until, send } = await link(t, stream => stream.pause());
  send(FRAME.OPEN, 2);
  for (let sent = 0; sent <= WINDOW; sent += 64 * 1024) send(FRAME.DATA, 2, Buffer.alloc(64 * 1024));
  await until(() => frames.some(f => f.type === FRAME.RESET && f.stream === 2));
});

test('duplicate ids, too many streams, unknown streams and HELLO', async t => {
  const accepted = [];
  let hellos = 0;
  const { channel, frames, until, send } = await link(t, stream => { accepted.push(stream); stream.on('close', () => {}); }, { onHello: () => { hellos++; } });
  send(FRAME.OPEN, 1); send(FRAME.OPEN, 1);
  await until(() => frames.some(f => f.type === FRAME.RESET && f.stream === 1));
  for (let id = 2; id <= MAX_STREAMS + 1; id++) send(FRAME.OPEN, id);
  await until(() => frames.some(f => f.type === FRAME.RESET && f.stream === MAX_STREAMS + 1));
  assert.equal(channel.openStreams, MAX_STREAMS);
  send(FRAME.DATA, 99999, Buffer.from('late'));
  await until(() => frames.some(f => f.type === FRAME.RESET && f.stream === 99999));

  send(FRAME.HELLO, 0, Buffer.from([1]));
  await until(() => hellos === 1);
  assert.equal(channel.openStreams, 0, 'a restarted relay invalidates every stream');
  assert.ok(accepted.every(stream => stream.destroyed));
});

test('a malformed frame closes the link and every stream', async t => {
  let reason = '';
  const { guest, send } = await link(t, () => {}, { onClose: r => { reason = r; } });
  send(FRAME.OPEN, 1);
  const bad = Buffer.alloc(9); bad.writeUInt8(9, 0);
  guest.write(bad);
  await once(guest, 'close');
  assert.equal(reason, 'protocol error');
});

test('relayed streams go through the Egress Proxy like direct connections', async t => {
  const echo = createServer(socket => socket.on('data', d => socket.write(`echo:${d}`)));
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  const asked = [];
  const proxy = new EgressProxy({
    rules: EgressRules.empty(),
    approve: async request => { asked.push(request.host); return request.host === 'example.com' ? 'once' : 'deny'; },
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: () => connect(echo.address().port, '127.0.0.1'),
  });
  t.after(async () => { await proxy.close(); echo.close(); });
  const { frames, until, send } = await link(t, stream => proxy.accept(stream));

  send(FRAME.OPEN, 1);
  send(FRAME.DATA, 1, Buffer.from('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));
  await until(() => dataTo(frames, 1).includes('200 Connection Established'));
  send(FRAME.DATA, 1, Buffer.from('ping'));
  await until(() => dataTo(frames, 1).endsWith('echo:ping'));

  send(FRAME.OPEN, 2);
  send(FRAME.DATA, 2, Buffer.from('CONNECT other.org:443 HTTP/1.1\r\nHost: other.org:443\r\n\r\n'));
  await until(() => dataTo(frames, 2).includes('403'));
  assert.deepEqual(asked, ['example.com', 'other.org']);
});
