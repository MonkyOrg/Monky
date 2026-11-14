'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '..', '..', '..');
const clientRoot = path.join(repo, 'apps', 'client');

if (process.versions.electron) {
  runClient();
} else if (process.env.MONKY_BROWSER_APP_ROLE === 'bot') {
  void runBot().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { test } = require('node:test');
  test('real app command publishes parked site pixels to another desktop and retires its session', { timeout: 180000 }, async () => {
    const cp = require('node:child_process');
    const { syncBuiltinESMExports } = require('node:module');
    const http = require('node:http');
    const clients = [], children = [], failures = [];
    const spawn = cp.spawn;
    const botRoot = process.env.MONKY_BROWSER_APP_BOT_ROOT;
    const receipt = [], homes = [];
    const site = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      response.setHeader('Set-Cookie', 'browser-test=temporary; Path=/; SameSite=Strict');
      // Keep native input borders off the flat-color grid, including H264 ringing around those borders.
      response.end(`<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:${
        request.url.startsWith('/green') ? 'rgb(0,255,0)' : 'rgb(0,0,255)'}}input{position:absolute;left:32%;top:32%;width:10%}</style>
        <input id="site-field">`);
    });
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    cp.spawn = function(command, args, options) {
      const client = args[0] === clientRoot;
      const fixtureBot = !botRoot && options.env?.MONKY_QA_SERVICE
        && JSON.parse(options.env.MONKY_QA_SERVICE).role === 'bot';
      const child = Reflect.apply(spawn, this, [command,
        client || fixtureBot ? [__filename, ...args.slice(1)] : args,
        fixtureBot ? { ...options, env: { ...options.env, MONKY_BROWSER_APP_ROLE: 'bot' } } : options]);
      children.push(child);
      if (client) clients.push(child);
      child.stderr?.on('data', data => failures.push(data.toString()));
      return child;
    };
    syncBuiltinESMExports();
    const call = (child, action, value) => new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.removeListener('message', reply); child.removeListener('exit', exited); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Real app ${action} timed out.`)); }, 30000);
      const exited = () => { cleanup(); reject(new Error(`Real app exited during ${action}.`)); };
      const reply = message => {
        if (message?.type !== 'browser-app-result' || message.action !== action) return;
        cleanup();
        if (message.error) reject(new Error(message.error)); else resolve(message.value);
      };
      child.on('message', reply); child.once('exit', exited);
      child.send({ type: 'browser-app-test', action, value });
    });
    try {
      const { runQa } = await import(pathToFileURL(path.join(repo, 'scripts', 'qa.js')).href);
      await runQa({
        scenario: 'connected', twoClients: true, smoke: false, realMedia: false,
        bot: botRoot ? 'production' : 'fixture', ...(botRoot ? { botRoot } : {}),
      }, {
        async onReady(result) {
          assert.equal(clients.length, 2);
          if (process.env.MONKY_BROWSER_APP_HOST_MEMBER === '1') clients.reverse();
          const pixels = async (phase, color) => {
            await call(clients[0], 'navigate', `http://127.0.0.1:${site.address().port}/${color}-${receipt.length}`);
            const captured = await call(clients[0], 'sample', color);
            const result = { phase, captured, received: null };
            receipt.push(result);
            result.received = await call(clients[1], 'pixels', captured);
          };
          const home = async phase => {
            const document = await call(clients[0], 'home');
            const captured = await call(clients[0], 'sample', 'home');
            const result = { phase, document, captured, received: null };
            homes.push(result);
            result.received = await call(clients[1], 'pixels', captured);
          };
          await Promise.all(clients.map(child => call(child, 'join')));
          await call(clients[0], 'invoke');
          await home('initial opaque home before the first website');
          await pixels('creation without ever presenting the stage', 'blue');
          await call(clients[0], 'stage');
          await pixels('native site presented in the actual stage', 'green');
          await call(clients[0], 'park');
          await pixels('native site returned to its capture root', 'blue');
          await call(clients[0], 'stage');
          await pixels('same site returned to the stage', 'green');
          await call(clients[0], 'hide-window');
          await pixels('whole owner hidden in tray', 'blue');
          await call(clients[0], 'identity');
          await call(clients[0], 'minimize');
          await pixels('minimized owner', 'green');
          await call(clients[0], 'stage');
          await pixels('stage reopened after hide and minimize', 'blue');
          await call(clients[0], 'focus');
          await call(clients[0], 'close');
          await call(clients[1], 'retired');
          await call(clients[0], 'invoke');
          await home('new instance returns to home after close');
          await pixels('new instance has its own source after close', 'green');
          await call(clients[0], 'stage');
          await call(clients[0], 'end');
          await call(clients[1], 'retired');
          await call(clients[0], 'invoke');
          await home('new instance returns to home after ending the miniapp');
          await pixels('new instance before actual call leave', 'blue');
          await call(clients[0], 'leave');
          await call(clients[1], 'retired');
          for (const [index, child] of clients.entries()) child.send({ type: 'qa-stop',
            runId: result.clients[process.env.MONKY_BROWSER_APP_HOST_MEMBER === '1' ? 1 - index : index].runId });
        },
      });
      assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'Every owned QA process exited');
      console.log(JSON.stringify({ kind: botRoot ? 'MonkyBot' : 'SDK fixture',
        host: process.env.MONKY_BROWSER_APP_HOST_MEMBER === '1' ? 'member' : 'owner', homes, receipt }));
      console.log('Real app: parked creation, same native stage/root, owner hide/minimize, focus, close/end/leave and desktop pixels verified');
    } catch (error) {
      for (const child of clients) if (child.connected) {
        try { console.error(await call(child, 'state')); } catch (diagnosticError) { console.error(diagnosticError); }
      }
      console.error(JSON.stringify({ incompleteHomes: homes, incompleteReceipt: receipt }));
      console.error(failures.join('').slice(-16000));
      throw error;
    } finally {
      cp.spawn = spawn;
      syncBuiltinESMExports();
      site.closeAllConnections();
      await new Promise(resolve => site.close(resolve));
    }
  });

  test('browser pixel oracle accepts letterboxing but rejects blank, stale and mixed-color frames', async () => {
    const vm = require('node:vm');
    for (const [kind, accepted] of [['letterbox', true], ['blank', false], ['stale', false], ['mixed', false]]) {
      let stopped = false, cancelled = false, released = false, closed = false, read = false, x = 0, y = 0;
      const frame = { displayWidth: 1000, displayHeight: 1000, close() { closed = true; } };
      const reader = {
        async read() { if (read) return { done: true }; read = true; return { value: frame }; },
        async cancel() { cancelled = true; },
        releaseLock() { released = true; },
      };
      const sample = vm.runInNewContext(`(${sampleTrack.toString()})`, {
        performance, setTimeout, clearTimeout,
        MediaStreamTrackProcessor: class { readable = { getReader: () => reader }; },
        OffscreenCanvas: class {
          getContext() {
            return {
              drawImage(_frame, sourceX, sourceY) { x = sourceX; y = sourceY; },
              getImageData() {
                const color = kind === 'blank' || y < 400 || y > 600 ? [0, 0, 0, 255]
                  : kind === 'stale' || (kind === 'mixed' && x === 750) ? [0, 0, 255, 255] : [0, 255, 0, 255];
                return { data: new Uint8ClampedArray(color) };
              },
            };
          }
        },
      });
      const track = { id: kind, clone: () => ({ stop() { stopped = true; } }), getSettings: () => ({ deviceId: kind }) };
      if (accepted) assert.equal((await sample(track, 'green')).pixels.length, 49);
      else await assert.rejects(sample(track, 'green'), /Browser video source ended/);
      assert.ok(stopped && cancelled && released && closed, `${kind} releases every owned probe resource`);
    }
  });
}

function runClient() {
  const { app, BrowserWindow } = require('electron');
  app.setAppPath(clientRoot);
  const { MiniappBrowserWindows } = require('../dist-electron/main/miniappBrowserWindows.js');
  let owner, manager, current, captureCount = 0;
  const open = MiniappBrowserWindows.prototype.open;
  MiniappBrowserWindows.prototype.open = function(...args) {
    manager = this;
    return Reflect.apply(open, this, args);
  };
  app.on('browser-window-created', (_event, window) => {
    owner ??= window;
    window.webContents.on('console-message', details => {
      if (details.level === 'error') console.error(details.message);
    });
  });
  const run = script => owner.webContents.executeJavaScript(script, true);
  const until = async (condition, description) => {
    const deadline = Date.now() + 20000;
    while (!await condition()) {
      if (Date.now() >= deadline) throw new Error(description);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const entry = () => {
    assert.equal(manager?.entries.size, 1, 'Only the invoking desktop owns a native site');
    return [...manager.entries.values()][0];
  };
  async function action(name, value) {
    if (name === 'join') {
      // This desktop capture regression must not inherit the compact first-launch window.
      owner.setContentSize(1100, 850);
      await until(() => run(`!!document.querySelector('.main-layout:not([data-compact])')`),
        'Desktop publication viewport did not settle');
      await run(`document.querySelector('[data-channel-type="VOICE"]:not([data-afk-channel])').click()`);
      await until(() => run(`!!document.querySelector('#voice-connection-row') &&
        !document.querySelector('#voice-connection-row').matches('.connecting,.reconnecting')`), 'Real voice join failed');
    } else if (name === 'invoke') {
      await run(`(()=>{
        if(!window.browserAppInstrumented){
        window.browserAppInstrumented=true;
        window.browserAppCaptures=[];
        window.browserAppCaptureEvents=[];
        window.browserAppTrackClones=[];
        const observeTrack=(track,kind)=>{
          const record=event=>browserAppCaptureEvents.push({
            kind,event,id:track.id,muted:track.muted,state:track.readyState,settings:track.getSettings()
          });
          record('acquired');
          for(const event of ['mute','unmute','ended']) track.addEventListener(event,()=>record(event));
        };
        const clone=MediaStreamTrack.prototype.clone;
        MediaStreamTrack.prototype.clone=function(){
          const track=Reflect.apply(clone,this,[]);
          observeTrack(track,'clone');
          window.browserAppTrackClones.push({parent:this.id,track});return track;
        };
        window.browserAppPeers=[];
        const NativePeer=RTCPeerConnection;
        window.RTCPeerConnection=class extends NativePeer{
          constructor(...args){super(...args);window.browserAppPeers.push(this);}
        };
        const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia=async constraints=>{
          try{const stream=await capture(constraints);window.browserAppCaptures.push(stream);
            stream.getTracks().forEach(track=>observeTrack(track,'original'));return stream;}
          catch(error){console.error('[Browser app capture]',error.name,error.message);throw error;}
        };
        }
        document.querySelector('[data-channel-type="TEXT"]').click();
      })()`);
      await until(() => run(`!!document.querySelector('#chat-message-input')`), 'Real composer missing');
      await run(`document.querySelector('#chat-message-input').value='/browser';
        document.querySelector('#chat-message-input').dispatchEvent(new Event('input',{bubbles:true}));
        document.querySelector('#btn-send-message').click()`);
      await until(async () => {
        const alerts = await run(`[...document.querySelectorAll('[role="alert"]')].map(element=>element.textContent.trim()).filter(Boolean)`);
        assert.deepEqual(alerts, [], 'The real command must not report a broadcast failure');
        return manager?.entries.size === 1 && entry().broadcasting;
      }, 'Real browser publication was not confirmed');
      assert.equal(entry().container.getVisible(), false, 'Publication starts before the stage is ever displayed');
      assert.equal(await run(`document.querySelector('.miniapp-browser-tile').closest('[hidden]') !== null`), true);
      assert.equal(await run(`document.querySelectorAll('.native-screen-presentation-owner').length`), 0);
      assert.deepEqual(await run(`browserAppCaptures.at(-1).getTracks().map(track=>track.kind)`), ['video']);
      const browser = entry();
      current = { view: browser.view, site: browser.view.webContents, session: browser.session,
        root: browser.site?.root, rootShows: 0, captureCount: ++captureCount };
      if (current.root) {
        current.root.on('show', () => current.rootShows++);
        assert.equal(current.root.isVisible(), false);
        assert.ok(current.root.contentView.children.includes(browser.view));
      }
    } else if (name === 'home') {
      const browser = entry();
      assert.equal(browser.view.webContents.getURL(), 'about:blank');
      assert.equal((await manager.control(browser.toolbar.webContents, { action: 'state' })).url, '');
      const home = await browser.view.webContents.executeJavaScript(`(async()=>{
        await document.fonts.ready;
        return {heading:document.querySelector('[data-miniapp-browser-home] h1')?.textContent,
          hint:document.querySelector('#browser-home-hint')?.textContent,locale:document.documentElement.lang,
          background:getComputedStyle(document.body).backgroundColor,base:getComputedStyle(document.documentElement).backgroundColor,
          font:getComputedStyle(document.body).fontFamily,
          inter:[...document.fonts].some(font=>font.family==='Inter'&&font.status==='loaded'),
          bridge:[typeof window.api,typeof window.miniappBrowser,typeof require,typeof process]};
      })()`);
      assert.equal(home.heading, browser.input.locale === 'en' ? 'Your Monky browser' : 'Seu navegador no Monky');
      assert.equal(home.locale, browser.input.locale);
      assert.equal(home.base, 'rgb(11, 14, 20)', 'An opaque base remains even with translucent custom theme colors');
      assert.equal(home.inter, true);
      assert.deepEqual(home.bridge, ['undefined','undefined','undefined','undefined']);
      return home;
    } else if (name === 'navigate') {
      const browser = entry();
      await browser.toolbar.webContents.executeJavaScript(`(()=>{
        const address=document.querySelector('input');
        if(address.disabled) throw new Error('Navigation opened before publication confirmation');
        address.value=${JSON.stringify(value)};
        document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      })()`, true);
      await until(() => browser.view.webContents.getURL() === value && !browser.view.webContents.isLoading(), 'Real toolbar did not navigate');
      assert.equal(browser.view.webContents.getLastWebPreferences().preload, undefined);
      assert.equal(browser.view.webContents.getLastWebPreferences().sandbox, true);
      assert.equal(await browser.view.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'),
        new URL(value).pathname.startsWith('/green') ? 'rgb(0, 255, 0)' : 'rgb(0, 0, 255)');
      assert.equal(await browser.view.webContents.executeJavaScript('!!document.querySelector("[data-miniapp-browser-home]")'), false,
        'The home disappears with navigation instead of covering the website');
    } else if (name === 'sample') {
      const browser = entry(), { BrowserWindow: Windows } = require('electron');
      assert.equal(browser.view, current.view);
      assert.equal(browser.view.webContents, current.site);
      assert.equal(browser.session, current.session);
      assert.equal(browser.site?.root, current.root);
      if (current.root) assert.equal(current.root.isVisible(), false);
      assert.equal(current.rootShows, 0);
      assert.equal(Windows.fromWebContents(browser.toolbar.webContents), owner);
      assert.equal(Windows.fromWebContents(current.site), browser.container.getVisible() || !current.root ? owner : current.root);
      await until(() => run(`(()=>{
        const original=browserAppCaptures.at(-1).getVideoTracks()[0];
        return browserAppPeers.flatMap(peer=>peer.getSenders()).filter(sender=>sender.track?.kind==='video'&&
          browserAppTrackClones.some(copy=>copy.parent===original.id&&copy.track===sender.track)).length===1;
      })()`), 'The browser rendition was not attached to its actual sender');
      const samples = await run(`(async()=>{
        const original=browserAppCaptures.at(-1).getVideoTracks()[0];
        const senders=browserAppPeers.flatMap(peer=>peer.getSenders()).filter(sender=>sender.track?.kind==='video'&&
          browserAppTrackClones.some(copy=>copy.parent===original.id&&copy.track===sender.track));
        if(senders.length!==1) throw new Error('Exactly one actual browser rendition sender is required');
        const sent=senders[0].track;
        const samples=await Promise.all([(${sampleTrack.toString()})(original,${JSON.stringify(value)}),
          (${sampleTrack.toString()})(sent,${JSON.stringify(value)})]);
        return {original:samples[0],sent:samples[1],senderExact:senders[0].track===sent,
          captures:browserAppCaptures.length};
      })()`);
      assert.equal(samples.original.device, samples.sent.device);
      assert.equal(samples.captures, current.captureCount, 'Presentation cannot reacquire or retarget capture');
      const identity = { original: samples.original.track, sent: samples.sent.track, source: samples.original.device };
      current.captureIdentity ??= identity;
      assert.deepEqual(identity, current.captureIdentity, 'Presentation preserves the original and actual sender track identities');
      const compared = samples.sent.pixels.filter((pixel, index) =>
        value !== 'home' || (pixel.flat && samples.original.pixels[index].flat));
      assert.ok(value !== 'home' || compared.length >= 220, 'Home comparison covers flat surfaces across the full distributed grid');
      const differences = compared.filter(pixel => {
        const original = samples.original.pixels.find(point => point.x === pixel.x && point.y === pixel.y);
        return pixel.rgba.some((channel, component) => Math.abs(channel-original.rgba[component]) > 12);
      });
      assert.deepEqual(differences, [], JSON.stringify({ color:value, compared:compared.length,
        original:[samples.original.width,samples.original.height],sent:[samples.sent.width,samples.sent.height] }));
      return { ...samples, comparedPoints:compared.length, ownerVisible: owner.isVisible(), presented: browser.container.getVisible(),
        root: current.root?.id, site: current.site.id,
        geometry: current.root ? { root: current.root.getBounds(), content: current.root.getContentSize(), view: current.view.getBounds() } : null,
        frame: { process: current.site.mainFrame.processId, routing: current.site.mainFrame.routingId,
          tree: current.site.mainFrame.frameTreeNodeId },
        viewport: await current.site.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})') };
    } else if (name === 'pixels') {
      assert.equal(manager?.entries.size ?? 0, 0, 'A spectator never gets a native site or its session');
      return run(`(async()=>{
        let video=document.querySelector('video.miniapp-browser-viewer');
        const deadline=performance.now()+20000;
        while((!video || video.readyState<2) && performance.now()<deadline){
          await new Promise(resolve=>setTimeout(resolve,20));
          video=document.querySelector('video.miniapp-browser-viewer');
        }
        if(!video || video.readyState<2) throw new Error('Desktop browser video is unavailable');
        window.browserAppViewerTrack=video.srcObject.getVideoTracks()[0];
        return (${sampleTrack.toString()})(browserAppViewerTrack,${JSON.stringify(value.sent.color)},
          ${JSON.stringify(value.sent.color === 'home' ? value.sent.pixels.filter(pixel => pixel.flat) : value.sent.pixels)});
      })()`);
    } else if (name === 'identity') {
      const identity = await run(`(async()=>{
        const original=browserAppCaptures.at(-1).getVideoTracks()[0];
        const senders=browserAppPeers.flatMap(peer=>peer.getSenders()).filter(sender=>sender.track?.kind==='video');
        const results=await Promise.all(senders.map(async sender=>{
          const stats=[...(await sender.getStats()).values()];
          const outbound=stats.find(report=>report.type==='outbound-rtp'&&report.framesEncoded>0);
          return {
            clone:browserAppTrackClones.some(copy=>copy.parent===original.id&&copy.track===sender.track),
            state:sender.track.readyState,original:original.readyState,
            frames:!!outbound,
            h264:stats.some(report=>report.type==='codec'&&report.id===outbound?.codecId&&report.mimeType==='video/H264')
          };
        }));
        return {results,retiredProbe:browserAppTrackClones.some(copy=>copy.parent===original.id&&copy.track.readyState==='ended')};
      })()`);
      assert.ok(identity.results.length > 0, 'The full app has a real video sender');
      assert.ok(identity.results.every(result => result.clone && result.state === 'live' && result.original === 'live'
        && result.frames && result.h264), 'Only the actual rendition cloned from the original capture reaches H264 senders');
      assert.equal(identity.retiredProbe, true, 'The first-frame clone has already been stopped');
    } else if (name === 'park') {
      await run(`document.querySelector('[data-channel-type="TEXT"]').click()`);
      await until(() => !entry().container.getVisible(), 'The real stage did not park');
      assert.equal(entry().container.getVisible(), false);
      assert.equal(await run(`document.querySelector('.miniapp-browser-tile').closest('[hidden]') !== null`), true);
      if (current.root) assert.ok(current.root.contentView.children.includes(current.view));
    } else if (name === 'stage') {
      if (owner.isMinimized()) owner.restore();
      owner.show(); owner.focus();
      await run(`(()=>{
        const id=${JSON.stringify(entry().input.screenId)};
        const button=document.querySelector('[data-member-miniapp="'+CSS.escape(id)+'"]');
        if(!button || !button.checkVisibility()) throw new Error('The real miniapp return control is unavailable');
        button.click();
      })()`);
      await until(() => entry().container.getVisible(), 'The real stage did not present its browser');
      assert.ok(entry().container.children.includes(current.view));
      if (current.root) assert.equal(current.root.contentView.children.includes(current.view), false);
    } else if (name === 'focus') {
      await current.site.executeJavaScript('document.querySelector("input").focus();document.querySelector("input").value="kept";true');
      current.site.focus();
      await current.site.executeJavaScript('document.activeElement.id === "site-field"').then(focused => assert.equal(focused, true));
      current.site.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
      await until(() => entry().toolbar.webContents.executeJavaScript('document.activeElement === document.querySelector("input")'),
        'The address shortcut did not focus the original owner toolbar');
      assert.equal(await current.site.executeJavaScript('document.querySelector("input").value'), 'kept');
    } else if (name === 'hide-window') {
      owner.hide();
      await until(() => !owner.isVisible() && !entry().container.getVisible(), 'The hidden owner did not park its site');
      assert.equal(owner.isVisible(), false);
      assert.equal(entry().container.getVisible(), false);
    } else if (name === 'minimize') {
      owner.show(); owner.minimize();
      await until(() => owner.isMinimized() && !entry().container.getVisible(), 'The minimized owner did not park its site');
      assert.equal(entry().container.getVisible(), false);
    } else if (name === 'close' || name === 'end' || name === 'leave') {
      const browser = entry(), site = browser.view.webContents;
      assert.ok((await browser.session.cookies.get({})).some(cookie => cookie.name === 'browser-test'));
      if (name === 'leave') await run(`document.querySelector('#sidebar-btn-leave-voice').click()`);
      else await run(`document.querySelector('.stage-bot-browser-card [data-bot-screen-action="${name}"]').click()`);
      await until(() => site.isDestroyed(), 'Closing the real tile did not destroy the site');
      await manager.closeAll();
      assert.deepEqual(await browser.session.cookies.get({}), []);
      assert.equal(await run(`browserAppCaptures.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))`), true);
      assert.equal(await run(`document.querySelectorAll('.native-screen-presentation-owner').length`), 0);
      if (current.root) assert.equal(current.root.isDestroyed(), true);
      assert.equal(current.site.isDestroyed(), true);
    } else if (name === 'retired') {
      await until(() => run(`window.browserAppViewerTrack?.readyState==='ended' &&
        !document.querySelector('video.miniapp-browser-viewer')`), 'Spectator retained retired pixels');
    } else if (name === 'state') {
      return {
        site: manager?.entries.size ? { url: entry().view.webContents.getURL(), background: entry().view.webContents.getBackgroundThrottling(),
          bounds: entry().view.getBounds(), clip: entry().container.getBounds(), visible: entry().container.getVisible(),
          ready: entry().ready, requestedVisible: entry().visible, placementVisible: entry().placementVisible,
          requestedBounds: entry().bounds, requestedClip: entry().clip,
          document: await entry().view.webContents.executeJavaScript(`({
            color:getComputedStyle(document.body).backgroundColor,visibility:document.visibilityState,
            width:innerWidth,height:innerHeight
          })`) } : null,
        renderer: await run(`({
          visibility:document.visibilityState,
          activeChannels:[...document.querySelectorAll('.channel-item.active')].map(element=>({...element.dataset})),
          slots:[...document.querySelectorAll('#stage-participants-area [data-tile-key]')].map(element=>({
            ...element.dataset,bounds:element.getBoundingClientRect().toJSON(),
            parent:element.parentElement.className,
          })),
          browserAncestors:(()=>{
            const result=[];for(let element=document.querySelector('.miniapp-browser-tile');element;element=element.parentElement){
              const style=getComputedStyle(element);result.push({class:element.className,id:element.id,hidden:element.hidden,
                inert:element.inert,opacity:style.opacity,display:style.display,visibility:style.visibility,
                bounds:element.getBoundingClientRect().toJSON()});
            }return result;
          })(),
          layers:[...document.querySelectorAll('[role="dialog"],[role="menu"],[role="alert"],.chat-copy-toast,.modal-backdrop')]
            .filter(element=>element.checkVisibility()).map(element=>({class:element.className,text:element.textContent,
              bounds:element.getBoundingClientRect().toJSON()})),
          captures:window.browserAppCaptures?.map(stream=>stream.getTracks().map(track=>({state:track.readyState,settings:track.getSettings()}))),
          captureEvents:window.browserAppCaptureEvents,
          videos:[...document.querySelectorAll('video')].map(video=>{
            const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
            const context=canvas.getContext('2d');
            if(video.readyState>=2) context.drawImage(video,video.videoWidth/2,video.videoHeight/2,1,1,0,0,1,1);
            return {class:video.className,ready:video.readyState,width:video.videoWidth,height:video.videoHeight,
              pixel:[...context.getImageData(0,0,1,1).data]};
          })
        })`),
      };
    } else throw new Error('Unsupported browser app test action');
    return true;
  }
  process.on('message', message => {
    if (message?.type !== 'browser-app-test') return;
    void action(message.action, message.value).then(
      value => process.send({ type: 'browser-app-result', action: message.action, value }),
      async error => {
        try { console.error(JSON.stringify({ failedAction: message.action, state: await action('state') })); }
        catch (diagnosticError) { console.error(diagnosticError); }
        process.send({ type: 'browser-app-result', action: message.action, error: error.stack });
      });
  });
  require('../dist-electron/main/main.js');
}

async function sampleTrack(track, color, expected) {
  const clone = track.clone();
  const reader = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 1 }).readable.getReader();
  const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d');
  const deadline = performance.now() + 15000;
  let retired = false, last, differences;
  try {
    while (performance.now() < deadline) {
      let timer;
      const read = reader.read();
      void read.then(result => { if (retired) result.value?.close(); }, () => {});
      let result;
      try {
        result = await Promise.race([read, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`No new ${color} browser frame; last=${JSON.stringify(last)}; differences=${JSON.stringify(differences)}`)),
            Math.max(1, deadline - performance.now()));
        })]);
      } finally { clearTimeout(timer); }
      const frame = result.value;
      if (!frame) throw new Error('Browser video source ended');
      try {
        const pixels = [], axis = color === 'home' ? Array.from({length:21},(_,index)=>(index+.5)/21) : [.02,.1,.25,.5,.75,.9,.98];
        const points = expected || axis.flatMap(y => axis.map(x => ({x,y})));
        canvas.width = canvas.height = color === 'home' ? 7 : 1;
        for (const {x,y} of points) {
          const radius = color === 'home' ? 3 : 0, size = radius*2+1;
          context.drawImage(frame, Math.floor(frame.displayWidth*x)-radius, Math.floor(frame.displayHeight*y)-radius,
            size, size, 0, 0, size, size);
          const rgba = [...context.getImageData(radius,radius,1,1).data];
          const data = context.getImageData(0,0,size,size).data;
          const flat = data.every((channel,index) => Math.abs(channel-rgba[index%4]) <= 3);
          pixels.push({ x, y, rgba, ...(color === 'home' ? {flat} : {}) });
        }
        last = pixels.filter(pixel => [.25,.5,.75].includes(pixel.x) && [.25,.5,.75].includes(pixel.y));
        differences = expected ? pixels.flatMap((pixel, index) =>
          pixel.rgba.some((channel, component) => Math.abs(channel - expected[index].rgba[component]) > 12)
            ? [{ ...pixel, expected: expected[index].rgba }] : []) : undefined;
        const siteColor = ({ rgba: [red, green, blue] }) => red < 35 &&
          (color === 'blue' ? blue > 200 && green < 35 : green > 180 && blue < 35);
        const matches = expected
          ? pixels.every((pixel, index) => pixel.rgba.every((channel, component) =>
            Math.abs(channel - expected[index].rgba[component]) <= 12))
          : color === 'home' ? pixels.some(({flat,rgba:[red,green,blue]}) => flat &&
              red > 45 && green > 45 && blue > 130 && blue > red*1.5)
            && pixels.some(({flat,rgba:[red,green,blue]}) => flat && red > 5 && red < 80 && green < 80 && blue < 80)
            // Native aspect ratios can letterbox the site. Sender/receiver comparison still covers the full grid.
            : last.some(siteColor) && last.every(pixel =>
              siteColor(pixel) || pixel.rgba.slice(0, 3).every(channel => channel < 35));
        if (matches) return { color, track: track.id, device: track.getSettings().deviceId, pixels,
          width: frame.displayWidth, height: frame.displayHeight, timestamp: frame.timestamp,
          codedWidth: frame.codedWidth, codedHeight: frame.codedHeight };
      } finally { frame.close(); }
    }
    throw new Error(`No matching ${color} browser pixels; last=${JSON.stringify(last)}`);
  } finally {
    retired = true; clone.stop();
    await reader.cancel(); reader.releaseLock();
  }
}

async function runBot() {
  const { BotClient, PROTOCOL_VERSION } = require('@monky/bot-sdk');
  const { generateKeyPairSync } = require('node:crypto');
  const config = JSON.parse(process.env.MONKY_QA_SERVICE);
  const bot = new BotClient({
    name: 'Browser app SDK fixture', requestedCapabilities: ['commands', 'miniapps'],
    publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    registrationFile: path.join(process.cwd(), 'registrations.json'),
  });
  const connected = new Set();
  bot.on('connected', info => connected.add(info.serverId));
  bot.on('disconnected', info => connected.delete(info.serverId));
  bot.on('error', error => console.error(error));
  bot.command({ name: 'browser', description: 'Isolated browser app regression fixture', voiceRequirement: 'joined',
    handler: async context => { await context.createBrowserScreen({ title: 'Browser fixture' }); await context.reply('Created'); } });
  const server = await bot.serve({ name: 'Browser app SDK fixture', description: `Protocol ${PROTOCOL_VERSION} regression fixture`,
    port: 0, host: '127.0.0.1', publicHost: '127.0.0.1' });
  const stop = async () => { await bot.close(); process.exit(0); };
  process.once('disconnect', () => { void stop(); });
  process.on('message', message => {
    if (message?.runId !== config.runId) return;
    if (message.type === 'qa-stop') { void stop(); return; }
    if (message.type === 'qa-ping') process.send({ type: 'qa-response', id: message.id, value: { alive: true } });
    else if (message.type === 'qa-snapshot') process.send({ type: 'qa-response', id: message.id, value: {
      connected: [...connected], permissions: bot.getPermissions([...connected][0]), voice: false,
    } });
    else process.send({ type: 'qa-response', id: message.id, error: 'Unsupported browser fixture request' });
  });
  process.send({ type: 'qa-service-ready', value: { manifestUrl: `http://127.0.0.1:${server.address().port}/manifest`, kind: 'sdk-fixture' } });
}
