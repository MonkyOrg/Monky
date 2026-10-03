/**
 * Regenerates the screenshots shown in the onboarding guide and in the hosting
 * tutorials (src/renderer/assets/onboarding/<shot>-<language>.png).
 *
 * It renders the real renderer with fixture data, so run it again whenever the
 * Home, the add-server modal or the invite modal changes:
 *   npm run screenshots:onboarding
 *
 * Terminal shots are drawn here with sample addresses (documentation ranges and
 * private IPs, never this machine's) and the real `monky create` prompts.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientRoot, '..', '..');
const outputDir = path.join(clientRoot, 'src', 'renderer', 'assets', 'onboarding');
const LANGUAGES = ['pt-BR', 'en'];
const INVITE_VARIANTS = ['lan', 'public', 'radmin', 'hamachi', 'tailscale', 'zerotier'];
const WIDTH = 1100;
const HEIGHT = 760;

if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-onboarding-shots-'));
  const env = { ...process.env, MONKY_ONBOARDING_SHOTS_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  child.once('exit', (code) => {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    process.exit(code ?? 1);
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_ONBOARDING_SHOTS_PROFILE);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let phase = 'startup';
  const finish = async (code) => {
    if (window && !window.isDestroyed()) window.destroy();
    await vite?.close();
    app.exit(code);
  };
  const timer = setTimeout(() => {
    console.error(`Onboarding screenshots timed out during ${phase}`);
    void finish(1);
  }, 180_000);

  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    const mainPath = path.join(clientRoot, 'src', 'renderer', 'main.ts');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'onboarding-shots-fixture',
        enforce: 'pre',
        transform(code, id) {
          if (path.normalize(id.split('?')[0]) === mainPath) {
            return { code: `${code}\nexport { App as ShotsApp };`, map: null };
          }
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__onboarding_shots__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end(`<!doctype html><html><head>
              <link rel="stylesheet" href="/styles/fonts.css">
              <link rel="stylesheet" href="/styles/theme.css">
              <link rel="stylesheet" href="/styles/dropdowns.css">
              <link rel="stylesheet" href="/styles/footerControls.css">
              </head><body><div id="app"></div></body></html>`);
          });
        },
      }],
    });
    const http = vite.httpServer;
    if (!http) throw new Error('Missing Vite HTTP server');
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite listener');
    // The terminal shots quote the real `monky create` prompts in each language.
    const cliLocales = path.join(repoRoot, 'apps', 'server', 'src', 'cli', 'i18n', 'locales');
    const cliCatalogs = {
      'pt-BR': (await vite.ssrLoadModule(path.join(cliLocales, 'pt-BR.ts'))).ptBR,
      en: (await vite.ssrLoadModule(path.join(cliLocales, 'en.ts'))).en,
    };

    window = new BrowserWindow({
      show: false, width: WIDTH, height: HEIGHT, useContentSize: true, backgroundColor: '#1e1f22',
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setFrameRate(30);
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.error(`[renderer:${phase}] ${event.message}`);
    });
    const evaluate = (code) => window.webContents.executeJavaScript(code, true);
    const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));
    const capture = async (name, rect) => {
      await settle();
      const area = typeof rect === 'function' ? await rect() : rect;
      const image = await window.webContents.capturePage(area);
      const file = path.join(outputDir, name);
      fs.writeFileSync(file, image.toPNG());
      const size = image.getSize();
      console.log(`  ${path.relative(clientRoot, file)} (${size.width}x${size.height}, ${Math.round(fs.statSync(file).size / 1024)} KB)`);
    };
    const cardRect = (endSelector) => evaluate(`(() => {
      const box = document.querySelector('.add-server-card').getBoundingClientRect();
      const end = ${JSON.stringify(endSelector ?? null)};
      const endBox = end ? document.querySelector(end).getBoundingClientRect() : null;
      // Round inwards so sub-pixel card edges never pick up the page behind.
      const top = Math.max(0, Math.ceil(box.top));
      const bottom = Math.floor(Math.min(endBox ? endBox.bottom + 20 : box.bottom, innerHeight));
      const left = Math.ceil(box.left);
      return { x: left, y: top, width: Math.floor(box.right) - left, height: bottom - top };
    })()`);
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const waitFor = (selector) => evaluate(`new Promise((resolve, reject) => {
      let attempts = 0;
      const poll = () => {
        if (document.querySelector(${JSON.stringify(selector)})) return resolve(true);
        if (++attempts > 200) return reject(new Error('Missing ' + ${JSON.stringify(selector)}));
        setTimeout(poll, 25);
      };
      poll();
    })`);

    fs.mkdirSync(outputDir, { recursive: true });
    for (const language of LANGUAGES) {
      phase = `${language} setup`;
      console.log(`Onboarding screenshots (${language})`);
      await window.webContents.session.clearStorageData({ storages: ['localstorage'] });
      await window.loadURL(`http://127.0.0.1:${address.port}/__onboarding_shots__`);
      await evaluate(`(${setupFixture.toString()})(${JSON.stringify(language)})`);

      phase = `${language} home`;
      await evaluate(`(${highlightAddButton.toString()})()`);
      await capture(`home-${language}.png`, { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      await evaluate(`document.querySelector('#onboarding-shot-ring')?.remove()`);

      phase = `${language} add-server choice`;
      await click('#server-rail-add');
      await waitFor('#add-server-option-create');
      // The guide itself shows this shot, so hide its own "need help?" entry point.
      await evaluate(`document.querySelector('.add-server-guide-row').hidden = true`);
      await capture(`add-server-choice-${language}.png`, () => cardRect());
      await evaluate(`document.querySelector('.add-server-guide-row').hidden = false`);

      phase = `${language} add-server create`;
      await click('#add-server-option-create');
      await waitFor('#add-server-create-form');
      await capture(`add-server-create-${language}.png`, () => cardRect('.add-server-switch-row'));

      phase = `${language} add-server join`;
      await click('#add-server-create-back');
      await waitFor('#add-server-option-join');
      await click('#add-server-option-join');
      await waitFor('#add-server-join-form');
      await capture(`add-server-join-${language}.png`, () => cardRect());
      await click('#add-server-close');
      await evaluate(`(${waitUntilGone.toString()})('.add-server-card')`);

      for (const variant of INVITE_VARIANTS) {
        phase = `${language} invite ${variant}`;
        await evaluate(`(${openInviteShot.toString()})(${JSON.stringify(language)}, ${JSON.stringify(variant)})`);
        // Mark after the modal's entrance animation so the ring lands on the select.
        await capture(`invite-${variant}-${language}.png`, () => evaluate(`(${markInviteShot.toString()})()`));
        await evaluate(`(${closeInviteShot.toString()})()`);
      }

      const terminals = terminalSpecs(language, cliCatalogs[language], latestVersion());
      for (const [name, spec] of Object.entries(terminals)) {
        phase = `${language} ${name}`;
        const rect = await evaluate(`(${renderTerminalShot.toString()})(${JSON.stringify(spec)})`);
        await capture(`${name}-${language}.png`, rect);
        await evaluate(`document.querySelector('#terminal-shot')?.remove()`);
      }
    }
    clearTimeout(timer);
    await finish(0);
  }).catch(async (error) => {
    console.error(`Onboarding screenshots failed during ${phase}`, error);
    clearTimeout(timer);
    await finish(1);
  });
}

/** Runs in the renderer: fixture bridge, sample friends/servers, then the App. */
async function setupFixture(language) {
  const pt = language === 'pt-BR';
  const now = Date.now();
  const key = (seed) => seed.repeat(32).slice(0, 64);
  const friend = (publicKey, nickname, since) => ({
    publicKey, nickname, avatar: null, relation: 'friend', blocked: false,
    friendSince: since, requestedAt: null, maxFileBytes: 25 * 1024 * 1024,
  });
  const peers = [
    friend(key('a1'), 'Ana', now - 9e8),
    friend(key('b2'), 'Bruno', now - 8e8),
    friend(key('c3'), 'Carla', now - 7e8),
    friend(key('d4'), 'Diego', now - 6e8),
    { ...friend(key('e5'), 'Eva', null), relation: 'incoming', requestedAt: now - 3e5 },
  ];
  const conversations = [
    {
      peer: key('a1'), lastMessageAt: now - 6e4, lastMessagePreview: pt ? 'Bora jogar hoje à noite?' : 'Up for a game tonight?',
      lastMessageAuthor: key('a1'), unread: 2, hidden: false, readOnly: false,
    },
    {
      peer: key('b2'), lastMessageAt: now - 36e5, lastMessagePreview: pt ? 'Valeu pelo convite!' : 'Thanks for the invite!',
      lastMessageAuthor: key('b2'), unread: 0, hidden: false, readOnly: false,
    },
  ];
  const snapshot = {
    me: { publicKey: key('f6') }, peers, conversations, settings: { maxFileBytes: 25 * 1024 * 1024 },
  };
  const ok = (value) => Promise.resolve({ ok: true, value });
  const dm = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === 'onEvent') return () => () => {};
      if (property === 'snapshot') return () => ok(snapshot);
      if (property === 'pendingPeers') return () => ok([]);
      if (property === 'conversation') return (peer) => ok({ peer, messages: [], hasMore: false, peerReadAt: 0 });
      return () => ok({});
    },
  });
  const noop = async () => {};
  const unsubscribe = () => () => {};
  window.api = {
    hasIdentity: async () => true,
    getIdentity: async () => ({ clientId: 'onboarding-shots', publicKey: key('f6') }),
    signChallenge: async (nonce) => `fixture:${nonce}`,
    getClientLogConfig: async () => ({ enabled: false }),
    writeClientLog: noop,
    onAppBeforeQuit: unsubscribe,
    onTrayToggleMute: unsubscribe,
    onTrayToggleDeafen: unsubscribe,
    updateTrayVoiceStatus: noop,
    setWindowInServer: noop,
    stopLanDiscovery: noop,
    startLanDiscovery: noop,
    onLanDiscoveryFound: unsubscribe,
    onLanDiscoveryLost: unsubscribe,
    hostServerStatus: async () => ({ isRunning: false, port: null, serverId: null }),
    hostServerStart: async () => ({ success: true }),
    hostServerStop: async () => ({ success: true }),
    hostServerDeleteData: async () => ({ success: true }),
    onHostServerStatusChanged: unsubscribe,
    setLanguage: noop,
    setMinimizeToTray: noop,
    signalRendererReady: () => {},
    maximize: noop,
    getAppVersion: async () => '0.0.0-screenshots',
    openExternal: noop,
    dm,
  };
  const saved = (host, port, name, lastConnected) => ({
    host, port, name, serverId: `server-${port}`, lastConnected, password: '',
  });
  localStorage.setItem('monky_language', language);
  localStorage.setItem('monky_saved_servers', JSON.stringify([
    saved('amigos.example', 5101, pt ? 'Galera' : 'Crew', 2),
    saved('jogos.example', 5102, pt ? 'Jogatina' : 'Game Night', 1),
  ]));
  localStorage.setItem('monky_nickname', pt ? 'Você' : 'You');
  localStorage.setItem('monky_settings', JSON.stringify({
    onboardingCompleted: true,
    autoConnectServers: false,
    autoEntryServerKeys: [],
  }));
  window.fetch = async () => { throw new Error('offline fixture'); };
  navigator.mediaDevices.enumerateDevices = async () => [];
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('Screenshots must not capture media'); };

  const { ShotsApp } = await import('/main.ts');
  new ShotsApp();
  const until = async (condition, message) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(message);
  };
  await until(() => document.querySelector('#home-view') && document.querySelector('[data-friends-tab="all"]'), 'Home did not render');
  document.querySelector('[data-friends-tab="all"]').click();
  await until(() => document.querySelectorAll('.friends-row').length > 0, 'Friends did not render');
}

/** Runs in the renderer: draws a ring around the rail "+" button. */
function highlightAddButton() {
  const target = document.querySelector('#server-rail-add').getBoundingClientRect();
  const ring = document.createElement('div');
  ring.id = 'onboarding-shot-ring';
  const pad = 6;
  Object.assign(ring.style, {
    position: 'fixed',
    left: `${target.left - pad}px`,
    top: `${target.top - pad}px`,
    width: `${target.width + pad * 2}px`,
    height: `${target.height + pad * 2}px`,
    border: '3px solid #23a55a',
    borderRadius: '50%',
    boxShadow: '0 0 0 4px rgba(35, 165, 90, 0.25), 0 0 18px rgba(35, 165, 90, 0.55)',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: '99999',
  });
  document.body.appendChild(ring);
}

/** Latest stable release tag, so the installer shot shows a real version. */
function latestVersion() {
  try {
    const tags = require('node:child_process')
      .execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd: repoRoot, encoding: 'utf8' })
      .split(/\r?\n/);
    // Releases are tagged -beta and later promoted without a new tag, so the newest number is the current one.
    const latest = tags.map((tag) => /^v(\d+\.\d+\.\d+)/.exec(tag)?.[1]).find(Boolean);
    if (latest) return latest;
  } catch {}
  return '35.0.8';
}

/**
 * Terminal transcripts, one spec per shot. A line is a list of [style, text]
 * segments; `label` adds a callout after it and `note` is a callout line.
 */
function terminalSpecs(language, cli, version) {
  const pt = language === 'pt-BR';
  const cliText = (key, vars = {}) => {
    const text = cli[key];
    if (typeof text !== 'string') throw new Error(`Missing CLI string ${key}`);
    return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
  };
  const user = pt ? 'voce' : 'you';
  const out = (text = '', style = 'plain') => ({ s: [[style, text]] });
  const ps = (command, label) => ({ s: [['prompt', `PS C:\\Users\\${user}> `], ['cmd', command]], label });
  const sh = (who, host, command, label) => ({
    s: [['user', `${who}@${host}`], ['plain', ':'], ['path', '~'], ['plain', '$ '], ['cmd', command]], label,
  });
  const ask = (question, answer = '', fallback) => ({
    s: [['plain', fallback === undefined ? `${question}: ` : `${question} (${fallback}): `], ['cmd', answer]],
  });
  const confirm = (question, defaultYes, answer = '') => ask(
    `${question} ${cliText(defaultYes ? 'prompt.confirmDefaultYes' : 'prompt.confirmDefaultNo')}`, answer,
  );
  const elided = out('⋯', 'dim');

  const ipconfig = pt ? {
    title: 'Configuração de IP do Windows',
    ethernet: 'Adaptador Ethernet Ethernet:',
    wifi: 'Adaptador de Rede sem Fio Wi-Fi:',
    media: 'Estado da mídia. . . . . . . . . . . . . .  ',
    mediaOff: 'mídia desconectada',
    dns: 'Sufixo DNS específico de conexão. . . . . . ',
    ipv6: 'Endereço IPv6 de link local . . . . . . . . ',
    ipv4: 'Endereço IPv4. . . . . . . .  . . . . . . . ',
    mask: 'Máscara de Sub-rede . . . . . . . . . . . . ',
    gateway: 'Gateway Padrão. . . . . . . . . . . . . . . ',
  } : {
    title: 'Windows IP Configuration',
    ethernet: 'Ethernet adapter Ethernet:',
    wifi: 'Wireless LAN adapter Wi-Fi:',
    media: 'Media State . . . . . . . . . . . ',
    mediaOff: 'Media disconnected',
    dns: 'Connection-specific DNS Suffix  . ',
    ipv6: 'Link-local IPv6 Address . . . . . ',
    ipv4: 'IPv4 Address. . . . . . . . . . . ',
    mask: 'Subnet Mask . . . . . . . . . . . ',
    gateway: 'Default Gateway . . . . . . . . . ',
  };
  const field = (label, value, callout) => ({
    s: [['plain', `   ${label}: `], [callout ? 'hl' : 'plain', value]], label: callout,
  });
  const wifiBlock = (mark) => [
    { s: [[mark === 'ip' ? 'hl' : 'plain', ipconfig.wifi]], label: mark === 'ip' ? (pt ? 'Seu adaptador' : 'Your adapter') : undefined },
    out(),
    field(ipconfig.dns, 'home'),
    field(ipconfig.ipv6, 'fe80::1c2b:9d4e:7a10:5f3c%12'),
    field(ipconfig.ipv4, '192.168.0.105', mark === 'ip' ? (pt ? 'Seu IP local' : 'Your local IP') : undefined),
    field(ipconfig.mask, '255.255.255.0'),
    field(ipconfig.gateway, '192.168.0.1', mark === 'gateway' ? (pt ? 'IP do roteador' : 'Router IP') : undefined),
  ];
  const windowsPane = (lines) => ({ style: 'windows', title: 'Windows PowerShell', lines });
  const vpsPane = (lines) => ({ style: 'unix', title: 'ubuntu@monky-vps: ~', lines });
  const vps = (command, label) => sh('ubuntu', 'monky-vps', command, label);

  const identityCode = 'MONKY-ID:eyJ2IjoxLCJzIjoiNnB0WnFQb1JkM2tYV0dhN2VjQ3pBIiwiYyI6IjhmM';
  const serverName = pt ? 'Galera' : 'Crew';
  const yes = pt ? 's' : 'y';

  return {
    'terminal-ipconfig': {
      panes: [windowsPane([
        ps('ipconfig'), out(), out(ipconfig.title), out(),
        out(ipconfig.ethernet), out(), field(ipconfig.media, ipconfig.mediaOff), field(ipconfig.dns, ''), out(),
        ...wifiBlock('ip'),
      ])],
    },
    'terminal-gateway': {
      panes: [
        windowsPane([ps('ipconfig'), out(), out(ipconfig.title), out(), ...wifiBlock('gateway')]),
        {
          style: 'unix', title: `${user}@notebook: ~`, badge: 'Linux', lines: [
            sh(user, 'notebook', 'ip route'),
            { s: [['plain', 'default via '], ['hl', '192.168.0.1'], ['plain', ' dev wlan0 proto dhcp metric 600']], label: pt ? 'IP do roteador' : 'Router IP' },
            out('192.168.0.0/24 dev wlan0 proto kernel scope link src 192.168.0.105 metric 600'),
          ],
        },
      ],
    },
    'terminal-ip-unix': {
      panes: [
        {
          style: 'unix', title: 'Terminal — zsh', badge: 'macOS', lines: [
            { s: [['plain', `${user}@MacBook-Air ~ % `], ['cmd', 'ipconfig getifaddr en0']] },
            { s: [['hl', '192.168.0.105']], label: pt ? 'Seu IP local' : 'Your local IP' },
          ],
        },
        {
          style: 'unix', title: `${user}@notebook: ~`, badge: 'Linux', lines: [
            sh(user, 'notebook', 'hostname -I'),
            { s: [['hl', '192.168.0.105'], ['plain', ' 172.17.0.1']], label: pt ? 'Seu IP local' : 'Your local IP' },
            sh(user, 'notebook', 'ip addr show wlan0'),
            out('3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP'),
            out('    link/ether 3c:22:fb:12:34:56 brd ff:ff:ff:ff:ff:ff'),
            { s: [['plain', '    inet '], ['hl', '192.168.0.105'], ['plain', '/24 brd 192.168.0.255 scope global dynamic wlan0']] },
            out('       valid_lft 86124sec preferred_lft 86124sec'),
          ],
        },
      ],
    },
    'terminal-ssh': {
      panes: [windowsPane([
        ps('ssh ubuntu@203.0.113.25', pt ? 'usuário@IP-da-VM' : 'user@VM-IP'),
        out("The authenticity of host '203.0.113.25 (203.0.113.25)' can't be established."),
        out('ED25519 key fingerprint is SHA256:Xk3v9Q1tYp0b7m2NcR8sLwz4HfJ6uEaD5gT1iKoVb2c.'),
        { s: [['plain', 'Are you sure you want to continue connecting (yes/no/[fingerprint])? '], ['cmd', 'yes']] },
        out("Warning: Permanently added '203.0.113.25' (ED25519) to the list of known hosts."),
        out('Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-1015-oracle x86_64)'),
        out(),
        out(' * Documentation:  https://help.ubuntu.com'),
        out(' * Management:     https://landscape.canonical.com'),
        out(' * Support:        https://ubuntu.com/pro'),
        out(),
        vps('', pt ? 'Você está na VM' : 'You are on the VM'),
      ])],
    },
    'terminal-monky-install': {
      // install.sh only speaks Portuguese, so both languages show its real output.
      panes: [vpsPane([
        vps('curl -fsSL https://monkyorg.github.io/install.sh | bash'),
        out('🐵 Monky CLI Installer', 'bold'),
        out(),
        out('Node.js v22.12.0 • npm 10.9.0', 'cyan'),
        out('Canal: estável', 'cyan'),
        out('Buscando última versão...', 'cyan'),
        out(`Versão: ${version}`, 'cyan'),
        out(),
        out('Instalando Monky CLI...', 'bold'),
        out(`https://github.com/MonkyOrg/Monky/releases/download/v${version}/monky-cli-${version}.tgz`, 'cyan'),
        out(),
        elided,
        out(),
        out('✅ Monky CLI instalado com sucesso!', 'ok'),
        out(),
        out('Comece com:', 'dim'),
        out('  monky create    — criar um novo servidor'),
        out('  monky --help    — ver todos os comandos'),
        out(),
        vps('sudo ufw allow 3000/tcp'),
        out('Rule added'),
        out('Rule added (v6)'),
        vps('sudo ufw allow 40000:49151/udp'),
        out('Rule added'),
        out('Rule added (v6)'),
      ])],
    },
    'terminal-monky-create': {
      panes: [vpsPane([
        vps('monky create'),
        ask(cliText('create.askDataDir'), '', './data'),
        { s: [['plain', `${cliText('create.identityCode')}: `], ['hl', identityCode]] },
        { s: [['plain', cliText('create.identityPassword')]] },
        {
          note: pt
            ? '↑ Gere o código no Monky: Configurações → Meu Perfil → Exportar identidade'
            : '↑ Generate the code in Monky: Settings → My Profile → Export identity',
        },
        ask(cliText('create.serverName'), serverName, cliText('create.defaultServerName')),
        ask(cliText('create.serverPort'), '', '3000'),
        { s: [['plain', cliText('create.serverPassword')]] },
        confirm(cliText('create.askMemberLimit'), false),
        elided,
        out(cliText('create.voiceModeChoice'), 'bold'),
        out(`  ${cliText('prompt.navigate')}`, 'dim'),
        { s: [['cyan', '❯'], ['plain', ' p2p']] },
        out(),
        out(cliText('create.summary'), 'bold'),
        out(`${cliText('label.dataDir')}: /home/ubuntu/data`),
        out(`${cliText('label.name')}: ${serverName}`),
        out(`${cliText('label.port')}: 3000`),
        out(`${cliText('label.voiceMode')}: p2p`),
        out(`${cliText('label.password')}: ${cliText('create.noPassword')}`),
        out(`${cliText('create.memberLimit')}: ${cliText('create.noLimit')}`),
        out(`${cliText('label.identity')}: ${identityCode.slice(0, 40)}...`),
        confirm(cliText('create.confirm'), true, yes),
        out(cliText('create.ownerConfigured'), 'ok'),
        elided,
        confirm(cliText('create.startNow'), true, yes),
        elided,
        out(cliText('lifecycle.started'), 'ok'),
      ])],
    },
  };
}

/** Runs in the renderer: resolves once nothing matches the selector. */
function waitUntilGone(selector) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const poll = () => {
      if (!document.querySelector(selector)) return resolve(true);
      if (++attempts > 200) return reject(new Error(`Still showing ${selector}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

/**
 * Runs in the renderer: opens the real invite modal with the interfaces a
 * server would report, selects the address the tutorial talks about and
 * returns the card rectangle.
 */
async function openInviteShot(language, variant) {
  const [{ inviteModal }, { getActiveNetworkClient }, { sessionManager }] = await Promise.all([
    import('/views/InviteModal.ts'),
    import('/core/NetworkClient.ts'),
    import('/core/SessionManager.ts'),
  ]);
  const vpns = {
    radmin: { name: 'Radmin VPN', address: '26.144.71.12' },
    hamachi: { name: 'Hamachi', address: '25.61.204.18' },
    tailscale: { name: 'Tailscale', address: '100.101.102.103' },
    zerotier: { name: 'ZeroTier One [8056c2e21c000001]', address: '10.147.17.25' },
  };
  // Descriptions mimic the server, which only speaks Portuguese; the modal
  // translates them from the type and name.
  const iface = (name, address, type) => ({ name, address, family: 'IPv4', type, description: name });
  const interfaces = [iface('Internet (IP Público)', '203.0.113.25', 'public')];
  if (vpns[variant]) interfaces.push(iface(vpns[variant].name, vpns[variant].address, 'vpn'));
  interfaces.push(iface('Wi-Fi', '192.168.0.105', 'lan'));
  interfaces.push(iface('Loopback Pseudo-Interface 1', '127.0.0.1', 'loopback'));
  const selected = variant === 'public' ? '203.0.113.25' : variant === 'lan' ? '192.168.0.105' : vpns[variant].address;

  getActiveNetworkClient().sendRequest = async () => ({
    port: 3000, serverName: language === 'pt-BR' ? 'Galera' : 'Crew', networkInterfaces: interfaces,
  });
  const getActive = sessionManager.getActive;
  sessionManager.getActive = () => ({ host: selected, port: 3000, password: 'fixture' });
  try {
    await inviteModal.open();
  } finally {
    sessionManager.getActive = getActive;
  }
  const select = document.querySelector('#select-invite-ip');
  select.value = selected;
  select.dispatchEvent(new Event('change'));
}

/** Runs in the renderer: rings the invite address select and returns the card rectangle. */
async function markInviteShot() {
  const target = document.querySelector('#select-invite-ip').getBoundingClientRect();
  const ring = document.createElement('div');
  ring.id = 'invite-shot-ring';
  Object.assign(ring.style, {
    position: 'fixed',
    left: `${target.left - 4}px`,
    top: `${target.top - 4}px`,
    width: `${target.width + 8}px`,
    height: `${target.height + 8}px`,
    border: '3px solid #23a55a',
    borderRadius: '10px',
    boxShadow: '0 0 0 4px rgba(35, 165, 90, 0.25), 0 0 18px rgba(35, 165, 90, 0.55)',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: '99999',
  });
  document.body.appendChild(ring);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const cards = document.querySelectorAll('.modal-backdrop .modal-card');
  const box = cards[cards.length - 1].getBoundingClientRect();
  const top = Math.max(0, Math.ceil(box.top));
  const left = Math.ceil(box.left);
  return { x: left, y: top, width: Math.floor(box.right) - left, height: Math.floor(Math.min(box.bottom, innerHeight)) - top };
}

/** Runs in the renderer: closes the invite modal opened by `openInviteShot`. */
async function closeInviteShot() {
  document.querySelector('#invite-shot-ring')?.remove();
  const { inviteModal } = await import('/views/InviteModal.ts');
  inviteModal.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/** Runs in the renderer: draws terminal windows on top of the page and returns their rectangle. */
function renderTerminalShot(spec) {
  document.querySelector('#terminal-shot')?.remove();
  const colors = {
    plain: '#cccccc', cmd: '#f2f2f2', prompt: '#cccccc', dim: '#7a7a7a', ok: '#16c60c',
    cyan: '#61d6d6', bold: '#f2f2f2', user: '#16c60c', path: '#3b78ff',
  };
  const root = document.createElement('div');
  root.id = 'terminal-shot';
  const multi = spec.panes.length > 1;
  Object.assign(root.style, {
    position: 'fixed', left: '0', top: '0', zIndex: '100000', width: '660px', boxSizing: 'border-box',
    display: 'flex', flexDirection: 'column', gap: '12px', padding: multi ? '12px' : '0', background: '#1e1f22',
  });
  for (const pane of spec.panes) {
    const windows = pane.style === 'windows';
    const frame = document.createElement('div');
    Object.assign(frame.style, {
      background: windows ? '#0c0c0c' : '#171717', overflow: 'hidden',
      border: multi ? '1px solid #3a3a3a' : 'none', borderRadius: multi ? '8px' : '0',
    });
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      display: 'flex', alignItems: 'center', gap: '8px', height: '30px', padding: '0 12px',
      background: windows ? '#1f1f1f' : '#2a2a2a', color: '#d0d0d0', font: '12px "Segoe UI", system-ui, sans-serif',
    });
    if (windows) {
      bar.innerHTML = '<span style="font-family: Consolas, monospace; color: #9cdcfe;">&gt;_</span>';
    } else {
      bar.innerHTML = ['#ff5f57', '#febc2e', '#28c840']
        .map((dot) => `<span style="width: 11px; height: 11px; border-radius: 50%; background: ${dot};"></span>`).join('');
    }
    const title = document.createElement('span');
    title.textContent = pane.title;
    Object.assign(title.style, { flex: '1', textAlign: windows ? 'left' : 'center', marginRight: windows ? '0' : '45px' });
    bar.appendChild(title);
    if (pane.badge) {
      const badge = document.createElement('span');
      badge.textContent = pane.badge;
      Object.assign(badge.style, {
        font: '600 11px "Segoe UI", system-ui, sans-serif', color: '#fff', background: '#5865f2', borderRadius: '999px', padding: '1px 8px',
      });
      bar.appendChild(badge);
    }
    if (windows) {
      const controls = document.createElement('span');
      controls.textContent = '─   ☐   ✕';
      controls.style.color = '#9a9a9a';
      bar.appendChild(controls);
    }
    frame.appendChild(bar);

    const body = document.createElement('div');
    Object.assign(body.style, {
      padding: '10px 14px 12px', font: '13px/19px "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace',
      color: colors.plain, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    });
    for (const line of pane.lines) {
      const row = document.createElement('div');
      row.style.minHeight = '19px';
      if (line.note) {
        row.textContent = line.note;
        Object.assign(row.style, {
          font: '600 12px/18px "Segoe UI", system-ui, sans-serif', color: '#57f287', whiteSpace: 'normal', margin: '1px 0 3px',
        });
        body.appendChild(row);
        continue;
      }
      for (const [style, text] of line.s) {
        const span = document.createElement('span');
        span.textContent = text;
        span.style.color = colors[style] ?? colors.plain;
        if (style === 'bold' || style === 'user') span.style.fontWeight = '700';
        if (style === 'hl') {
          Object.assign(span.style, {
            color: '#ffffff', background: 'rgba(35, 165, 90, 0.28)', boxShadow: '0 0 0 2px #23a55a', borderRadius: '3px',
          });
        }
        row.appendChild(span);
      }
      if (line.label) {
        const label = document.createElement('span');
        label.textContent = `← ${line.label}`;
        Object.assign(label.style, {
          display: 'inline-block', marginLeft: '12px', padding: '0 8px', borderRadius: '999px', background: '#23a55a',
          color: '#ffffff', font: '700 11px/17px "Segoe UI", system-ui, sans-serif', verticalAlign: '1px', whiteSpace: 'nowrap',
        });
        row.appendChild(label);
      }
      body.appendChild(row);
    }
    frame.appendChild(body);
    root.appendChild(frame);
  }
  document.body.appendChild(root);
  const box = root.getBoundingClientRect();
  return { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) };
}
