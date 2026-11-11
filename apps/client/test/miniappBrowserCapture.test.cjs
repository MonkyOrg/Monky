const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const { spawn } = require('node:child_process');
  for (const minimized of [false, true]) test(`never-shown site-only capture delivers real H264 pixels with file-origin ${minimized ? 'minimized' : 'visible'} owner`,
    { timeout: 90000 }, async () => {
    const profile = path.join(__dirname, '..', 'dist-test', `browser-capture-${minimized}-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_BROWSER_CAPTURE_PROFILE: profile, MONKY_BROWSER_CAPTURE_MINIMIZED: String(minimized) };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const http = require('node:http');
  const { app, BrowserWindow } = require('electron');
  const { registerMiniappBrowserIpc } = require('../dist-electron/main/ipc/miniappBrowserIpc.js');
  const { installWebContentsPolicy } = require('../dist-electron/main/webContentsPolicy.js');
  const { configureDevelopmentQaMedia } = require('../dist-electron/main/developmentQa.js');
  installWebContentsPolicy(app);
  configureDevelopmentQaMedia(app.commandLine, { realMedia: false, smoke: false });
  app.setPath('userData', process.env.MONKY_BROWSER_CAPTURE_PROFILE);
  let host, viewer, site, server, manager;
  const run = (contents, script) => contents.executeJavaScript(
    `(async()=>{try{return await eval(${JSON.stringify(script)});}catch(error){throw new Error(error.name+': '+error.message);}})()`, true);
  const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false };
  const timeout = setTimeout(() => { console.error('Native tab capture fixture timed out.'); app.exit(1); }, 60000);
  const finish = async code => {
    clearTimeout(timeout);
    try {
      for (const window of [host, viewer]) if (window && !window.isDestroyed()) {
        try { await run(window.webContents, `window.capture?.getTracks().forEach(track=>track.stop());
          window.sender?.getSenders().forEach(sender=>sender.track?.stop());window.sender?.close();window.receiver?.close();
          document.querySelector('video').srcObject=null`); }
        catch (error) { console.error('Capture fixture cleanup failed:', error); code = 1; }
      }
      await manager?.dispose();
      if (host && !host.isDestroyed()) host.destroy();
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    } catch (error) {
      console.error('Native fixture retirement failed:', error); code = 1;
    } finally { app.exit(code); }
  };
  app.whenReady().then(async () => {
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      response.end(request.url.startsWith('/site')
        ? `<!doctype html><style>html,body{margin:0;background:${request.url.includes('green') ? 'rgb(0,255,0)' : 'rgb(0,0,255)'};width:100%;height:100%}</style><title>Site only</title>`
        : '<!doctype html><style>body{background:rgb(255,0,0)}</style><video autoplay muted></video>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    host = new BrowserWindow({ width: 640, height: 520, webPreferences: preferences });
    viewer = new BrowserWindow({ show: false, webPreferences: preferences });
    const ownerFile = path.join(process.env.MONKY_BROWSER_CAPTURE_PROFILE, 'capture-owner.html');
    fs.writeFileSync(ownerFile, '<!doctype html><style>body{background:rgb(255,0,0)}</style><video autoplay muted></video>');
    await host.loadFile(ownerFile);
    if (process.env.MONKY_BROWSER_CAPTURE_MINIMIZED === 'true') host.minimize();
    await viewer.loadURL(base);
    manager = registerMiniappBrowserIpc(host);
    const input = {
      requestId: crypto.randomUUID(), policyVersion: 1, serverKey: 'qa', channelId: 'room', botId: 'bot',
      screenId: 'browser', instanceId: crypto.randomUUID(), viewerId: 'host', viewerSessionId: 'host-device',
      title: 'Browser', locale: 'en',
    };
    const opening = manager.open(input);
    manager.placement(input.requestId, { x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 0, height: 0 }, false);
    await opening;
    const entry = manager.entries.get(input.requestId);
    site = entry.view;
    const bounds = { x: 40, y: 100, width: 360, height: 300 };
    assert.equal(entry.container.getVisible(), false, 'The site has never been displayed');
    const sourceId = manager.captureSourceId(input.requestId);
    const ts = require('typescript');
    const module = { exports: {} };
    const sourceFile = path.join(__dirname, '..', 'src', 'renderer', 'views', 'BotBrowserView.ts');
    const source = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: sourceFile,
    }).outputText;
    require('node:vm').runInNewContext(`(function(exports,require,module){${source}\n})`)(
      module.exports, () => ({}), module);
    const captureMethod = module.exports.BotBrowserView.prototype.capture.toString();
    await run(host.webContents, `(async () => {
      window.api={captureMiniappBrowser:async()=>${JSON.stringify(sourceId)}};
      window.capture=await ({${captureMethod}}).capture.call({
        ready:Promise.resolve(),retired:false,input:{requestId:${JSON.stringify(input.requestId)}}
      });
      const probe=capture.getVideoTracks()[0].clone();
      const reader=new MediaStreamTrackProcessor({track:probe,maxBufferSize:1}).readable.getReader();
      const timestamps=new Set();
      let timeout;
      try{
        await Promise.race([(async()=>{
          while(timestamps.size<3){
            const {value:frame}=await reader.read();
            if(!frame)throw new Error('Static tab capture ended');
            try{
              if(!frame.displayWidth||!frame.displayHeight)throw new Error('Static tab has no pixels');
              timestamps.add(frame.timestamp);
            }finally{frame.close();}
          }
        })(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Static tab stopped refreshing')),15000);})]);
      }finally{clearTimeout(timeout);probe.stop();await reader.cancel();reader.releaseLock();}
      window.sender = new RTCPeerConnection();
      const clone=capture.getVideoTracks()[0].clone();clone.contentHint='detail';
      await clone.applyConstraints({width:{max:1920},height:{max:1080},frameRate:{max:30}});
      sender.addTransceiver(clone,{direction:'sendonly',streams:[new MediaStream()],sendEncodings:[{active:false,maxBitrate:6000000,maxFramerate:30}]});
      const capabilities=RTCRtpSender.getCapabilities('video').codecs;
      const codecs=capabilities.filter(codec=>
        codec.mimeType.toLowerCase()==='video/h264'&&/profile-level-id=42e0/i.test(codec.sdpFmtpLine??''));
      sender.getTransceivers()[0].setCodecPreferences([...codecs,...capabilities.filter(codec=>codec.mimeType.toLowerCase()==='video/rtx')]);
      await sender.setLocalDescription(await sender.createOffer());
      if(sender.iceGatheringState!=='complete') await new Promise(resolve=>sender.addEventListener('icegatheringstatechange',()=>{
        if(sender.iceGatheringState==='complete') resolve(); }));
    })()`);
    const offer = await run(host.webContents, 'sender.localDescription.toJSON()');
    await run(viewer.webContents, `(async () => {
      window.receiver = new RTCPeerConnection();
      receiver.ontrack=event=>document.querySelector('video').srcObject=event.streams[0];
      await receiver.setRemoteDescription(${JSON.stringify(offer)});
      await receiver.setLocalDescription(await receiver.createAnswer());
      if(receiver.iceGatheringState!=='complete') await new Promise(resolve=>receiver.addEventListener('icegatheringstatechange',()=>{
        if(receiver.iceGatheringState==='complete') resolve(); }));
    })()`);
    const answer = await run(viewer.webContents, 'receiver.localDescription.toJSON()');
    await run(host.webContents, `sender.setRemoteDescription(${JSON.stringify(answer)})`);
    await run(host.webContents, `(async()=>{const senderTrack=sender.getSenders()[0],parameters=senderTrack.getParameters();
      parameters.encodings[0].active=true;await senderTrack.setParameters(parameters);})()`);
    manager.broadcasting(input.requestId, true);
    manager.placement(input.requestId, bounds, bounds, false);
    await manager.control(entry.toolbar.webContents, { action: 'navigate', url: `${base}/site` });
    const pixels = color => run(viewer.webContents, `(async () => {
      const video=document.querySelector('video'), canvas=document.createElement('canvas');
      canvas.width=canvas.height=1;const context=canvas.getContext('2d'),deadline=performance.now()+15000;
      while(performance.now()<deadline){
        if(video.readyState>=2){
          context.drawImage(video,Math.floor(video.videoWidth/2),Math.floor(video.videoHeight/2),1,1,0,0,1,1);
          const pixel=Array.from(context.getImageData(0,0,1,1).data);
          if(${JSON.stringify(color)}==='blue' ? pixel[2]>220&&pixel[0]<30&&pixel[1]<30 : pixel[1]>180&&pixel[0]<30&&pixel[2]<30) return pixel;
        }
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      throw new Error('Viewer did not receive the ${color} site pixels');
    })()`);
    const blue = await pixels('blue');
    assert.ok(blue[2] > 220 && blue[0] < 30, 'The site is blue, while the surrounding owner is red');
    await manager.control(entry.toolbar.webContents, { action: 'navigate', url: `${base}/site?green` });
    await pixels('green');
    assert.equal(entry.container.getVisible(), false, 'Capture never forces the browser or owner to appear');
    const codecs = await run(host.webContents, `(async()=>[...(await sender.getStats()).values()]
      .filter(report=>report.type==='codec').map(report=>({mime:report.mimeType,fmtp:report.sdpFmtpLine})))()`);
    assert.ok(codecs.some(codec => codec.mime === 'video/H264' && /profile-level-id=42e0/i.test(codec.fmtp)));
    console.log('Real guarded file-origin site-only H264 capture and cross-renderer pixel delivery verified');
    await finish(0);
  }).catch(async error => { console.error(error?.name, error?.message, error); await finish(1); });
}
