// Synthetic native acquisition, actual Electron IPC and preload. No device or account service.
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { installNativeBridge } = require('../desktop/native-bridge.cjs');
function frame(kind, bytes) { const b=Buffer.from(bytes);const h=Buffer.alloc(5);h[0]=kind;h.writeUInt32BE(b.length,1);return Buffer.concat([h,b]); }
app.disableHardwareAcceleration();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ionbeam-native-test-'));
process.env.GLASGOW_DESKTOP_SOCKET = path.join(directory,'scan.sock');
let server, native, win;
app.whenReady().then(async () => {
  server=http.createServer((req,res)=>{
    if(req.method==='POST') {
      assert.equal(req.headers['x-iobeam-auth'],'test-user');
      let body='';req.on('data',data=>body+=data);req.on('end',()=>{
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify(req.url.endsWith('/start') ? {id:'test-session'} : JSON.parse(body)));
      });return;
    }
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Native scanner test</title>');
  });
  native=net.createServer(socket=>{
    let data=Buffer.alloc(0),sent=false;
    socket.on('data',part=>{
      data=Buffer.concat([data,part]);
      if(sent || data.length<4 || data.length<4+data.readUInt32BE(0))return;
      const command=JSON.parse(data.subarray(4).toString());assert.equal(command.kind,'raster');
      sent=true;
      const bytes=Buffer.concat([frame(2,[4,0,0xfc,0xff]),frame(0,'{"event":"done","chunks":1}')]);
      socket.write(bytes.subarray(0,2));setTimeout(()=>socket.end(bytes.subarray(2)),10);
    });
  });
  await Promise.all([new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>native.listen(process.env.GLASGOW_DESKTOP_SOCKET,resolve))]);
  const origin=`http://127.0.0.1:${server.address().port}`;
  win=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  installNativeBridge(ipcMain,win,origin);
  await win.loadURL(origin);
  const result=await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const packets=[];const timer=setTimeout(()=>reject(new Error('Native IPC timed out')),5000);
    window.ionbeamScanner.subscribe('test',packet=>{
      if(packet.type==='samples')packets.push(Array.from(new Uint16Array(packet.payload)));
      if(packet.type==='text')packets.push(JSON.parse(packet.payload));
      if(packet.type==='error'){clearTimeout(timer);reject(new Error(packet.message));}
      if(packet.type==='close'){clearTimeout(timer);resolve({packets,code:packet.code});}
      window.ionbeamScanner.ack('test');
    });
    window.ionbeamScanner.start({id:'test',kind:'raster',request:{resolution:128},token:'test-user'}).catch(reject);
  })`);
  assert.deepEqual(result.packets[0],[4,65532]);assert.equal(result.packets[1].event,'done');assert.equal(result.code,1000);
  fs.writeFileSync(path.resolve(__dirname,'../docs/renderer-test.json'),JSON.stringify(result,null,2));
  console.log('PASS: native Unix socket → Electron IPC → exact typed samples, completion and close');
  win.destroy();server.closeAllConnections();server.close();native.close();app.quit();
}).catch(error=>{console.error(error);server?.close();native?.close();app.exit(1);});
