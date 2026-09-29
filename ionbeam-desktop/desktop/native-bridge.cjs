const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { readFrames } = require('../runtime/ionbeam-web/backend/dist/streamFrames');

function installNativeBridge(ipcMain, window, origin) {
  const active = new Map();
  const socketPath = process.env.GLASGOW_DESKTOP_SOCKET || path.join(path.join(os.homedir(), '.cache'), 'ionbeam-desktop/scan.sock');
  function trusted(event) { return event.sender === window.webContents && new URL(event.senderFrame.url).origin === origin; }
  function send(id, packet) { if (!window.isDestroyed()) window.webContents.send('scanner:event', { id, ...packet }); }
  async function control(route, token, body) {
    const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Iobeam-Auth': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Scan authorization/recording failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
    return response.json();
  }
  async function finish(state, event) {
    if (!state.session) return event;
    const id = state.session; state.session = null;
    try { return await control(`/desktop-session/${id}/finish`, state.token, event); }
    catch (error) { return { ...event, persistence_warning: error.message }; }
  }
  function stop(id) {
    const state = active.get(id);
    if (state) { state.stopped = true; state.socket?.destroy(); state.ack?.(); }
  }
  ipcMain.on('scanner:ack', (event, id) => { if (trusted(event)) active.get(id)?.ack?.(); });
  ipcMain.handle('scanner:stop', (event, id) => { if (trusted(event)) stop(id); });
  ipcMain.handle('scanner:start', async (event, command) => {
    if (!trusted(event)) throw new Error('Untrusted scanner caller');
    if (!command || typeof command.id !== 'string' || command.id.length > 64 ||
        !['raster','vector','dac_ramp','adc'].includes(command.kind) || typeof command.token !== 'string') throw new Error('Invalid scan command');
    if (active.size) throw new Error('A native scan is already active; wait for Stop to complete');
    const state = { token: command.token, stopped: false, socket: null, ack: null, session: null };
    active.set(command.id, state);
    void (async () => {
      let terminal = false;
      try {
        const authorization = await control('/desktop-session/start', command.token, { kind: command.kind, request: command.request });
        state.session = authorization.id;
        if (state.stopped) return;
        const socket = state.socket = net.createConnection(socketPath);
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        if (state.stopped) return;
        const body = Buffer.from(JSON.stringify({ kind: command.kind, request: command.request, token: process.env.GLASGOW_TOKEN || '' }));
        if (body.length > 128 * 1024 * 1024) throw new Error('Scan request exceeds 128 MiB');
        const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
        socket.cork(); socket.write(length); socket.write(body); socket.uncork();
        for await (const frame of readFrames(Readable.toWeb(socket))) {
          if (state.stopped) break;
          if (terminal) throw new Error('Native data after completion');
          let packet;
          if (frame.kind === 0) {
            let message = JSON.parse(new TextDecoder().decode(frame.payload));
            terminal = message.event === 'done' || message.event === 'error';
            if (terminal) message = await finish(state, message);
            packet = { type: 'text', payload: JSON.stringify(message) };
          } else {
            packet = { type: 'samples', format: frame.kind === 2 ? 'uint16-le' : 'wire', payload: frame.payload.buffer };
          }
          // One outstanding IPC packet bounds the display queue. Samples stay
          // binary; the renderer never parses acquisition JSON arrays.
          let timer;
          const ack = new Promise((resolve, reject) => {
            state.ack = resolve;
            timer = setTimeout(() => reject(new Error('Scanner display stopped responding')), 10000);
          });
          send(command.id, packet);
          try { await ack; } finally { clearTimeout(timer); state.ack = null; }
        }
        if (!terminal && !state.stopped) throw new Error('Native scan ended without completion');
      } catch (error) {
        if (!state.stopped) send(command.id, { type: 'error', message: error.code === 'ENOENT'
          ? `Native acquisition socket is unavailable. Enable GLASGOW_DESKTOP_ENABLED=1 on the shared device service (${socketPath}).`
          : error.message });
      } finally {
        state.socket?.destroy();
        await finish(state, { event: 'cancelled' });
        active.delete(command.id);
        send(command.id, { type: 'close', code: state.stopped || terminal ? 1000 : 1011 });
      }
    })();
  });
  window.webContents.on('render-process-gone', () => { for (const id of active.keys()) stop(id); });
  window.on('closed', () => { for (const id of active.keys()) stop(id); });
}
module.exports = { installNativeBridge };
