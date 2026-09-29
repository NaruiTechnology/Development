const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFrames, MAX_FRAME } = require('../runtime/ionbeam-web/backend/dist/streamFrames');
function encodeFrame(kind, data) { const body = Buffer.from(data); const h = Buffer.alloc(5); h[0]=kind; h.writeUInt32BE(body.length,1); return Buffer.concat([h,body]); }

function stream(parts) { return new ReadableStream({ start(c) { parts.forEach(p => c.enqueue(p)); c.close(); } }); }
async function collect(parts) { const out = []; for await (const frame of readFrames(stream(parts))) out.push(frame); return out; }

test('arbitrary fragmentation and coalescing preserve every byte and event', async () => {
  const expected = Buffer.concat([encodeFrame(1, Buffer.from([0, 4, 255, 252])), encodeFrame(0, '{"event":"done"}')]);
  for (const step of [1, 2, 3, 5, 7, 1000]) {
    const pieces = []; for (let i = 0; i < expected.length; i += step) pieces.push(expected.subarray(i, i + step));
    const records = await collect(pieces);
    assert.deepEqual([...records[0].payload], [0, 4, 255, 252]);
    assert.equal(new TextDecoder().decode(records[1].payload), '{"event":"done"}');
  }
});
test('truncated, unknown and oversized frames fail closed', async () => {
  for (const input of [Buffer.from([1]), Buffer.from([1,0,0,0,2,7]), Buffer.from([9,0,0,0,0])]) {
    await assert.rejects(collect([input]));
  }
  const header = Buffer.alloc(5); header[0] = 1; header.writeUInt32BE(MAX_FRAME + 1, 1);
  await assert.rejects(collect([header]), /Invalid/);
});
test('empty payloads and empty stream are valid framing', async () => {
  assert.equal((await collect([])).length, 0);
  assert.equal((await collect([encodeFrame(1, Buffer.alloc(0))]))[0].payload.length, 0);
});

test('native uint16 packets retain byte order', async () => {
  const records = await collect([encodeFrame(2, Buffer.from([4,0,0xfc,0xff]))]);
  assert.deepEqual([...new Uint16Array(records[0].payload.buffer)], [4,65532]);
});
