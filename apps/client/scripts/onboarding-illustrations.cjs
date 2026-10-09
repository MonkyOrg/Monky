/**
 * Illustrations for tutorial steps that happen outside Monky and cannot be
 * photographed the same way for everyone: a home network, a router panel,
 * a public IP lookup and cloud consoles. They are drawn as HTML with the
 * Monky fonts and icons, use documentation and private addresses only, and
 * say they are illustrations wherever a real screen differs by vendor.
 *
 * Used by capture-onboarding-screenshots.cjs; each entry becomes
 * assets/onboarding/<name>-<language>.png.
 */

const GREEN = '#23a55a';

const STYLE = `
  #illustration-shot { font: 13px/1.45 Inter, 'Segoe UI', system-ui, sans-serif; color: #f0f3f6; background: #1e1f22; padding: 14px; }
  #illustration-shot * { box-sizing: border-box; }
  #illustration-shot .icon { font-family: 'Material Symbols Outlined'; font-weight: normal; font-style: normal; line-height: 1;
    letter-spacing: normal; text-transform: none; white-space: nowrap; direction: ltr; font-feature-settings: 'liga';
    -webkit-font-smoothing: antialiased; font-size: 18px; vertical-align: -4px; }
  .ill-hl { box-shadow: 0 0 0 3px ${GREEN}, 0 0 0 7px rgba(35, 165, 90, 0.25) !important; border-radius: 6px; }
  .ill-label { display: inline-block; padding: 1px 9px; border-radius: 999px; background: ${GREEN}; color: #fff;
    font: 700 11px/18px Inter, 'Segoe UI', sans-serif; white-space: nowrap; }
  .ill-note { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: #9da7b3; font-size: 12px; }
  .ill-note .icon { color: #5865f2; }

  .ill-browser { border: 1px solid #3a3f47; border-radius: 10px; overflow: hidden; background: #f6f7f9; color: #1f2328; }
  .ill-browser-bar { display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 12px; background: #dde1e6; }
  .ill-browser-bar .dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
  .ill-url { flex: 1; display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 12px;
    background: #fff; color: #57606a; font-size: 12px; }
  .ill-url .icon { font-size: 15px; vertical-align: 0; }

  .ill-router { display: grid; grid-template-columns: 168px 1fr; min-height: 330px; }
  .ill-router-menu { background: #26313d; color: #c9d1d9; padding: 12px 0; font-size: 12.5px; }
  .ill-router-brand { display: flex; align-items: center; gap: 8px; padding: 0 14px 12px; color: #fff; font-weight: 700; }
  .ill-router-item { display: flex; align-items: center; gap: 8px; padding: 6px 14px; }
  .ill-router-item.sub { padding-left: 34px; color: #aeb7c2; }
  .ill-router-item.open { color: #fff; }
  .ill-router-item.active { background: #0b6bcb; color: #fff; }
  .ill-router-menu .ill-hl { margin: 3px 8px; padding: 6px 10px; background: #0b6bcb; color: #fff; }
  .ill-router-main { padding: 16px 14px; min-width: 0; }
  .ill-router-main h4 { margin: 0 0 12px; font-size: 16px; color: #0b2948; }
  .ill-table { width: 100%; border-collapse: collapse; font-size: 11.5px; background: #fff; border: 1px solid #d0d7de; }
  .ill-table th { text-align: left; padding: 6px 7px; vertical-align: bottom; background: #eef1f4; color: #57606a; font-weight: 600; border-bottom: 1px solid #d0d7de; }
  .ill-table td { padding: 7px; border-bottom: 1px solid #eaeef2; white-space: nowrap; }
  .ill-table td.empty { text-align: center; color: #8c959f; padding: 16px; }
  .ill-button { display: inline-flex; align-items: center; gap: 4px; margin-top: 12px; padding: 6px 12px; border-radius: 6px;
    background: #0b6bcb; color: #fff; font-weight: 600; font-size: 12px; }
  .ill-button.secondary { background: #eef1f4; color: #24292f; border: 1px solid #d0d7de; }
  .ill-form { display: grid; grid-template-columns: 96px 1fr; gap: 9px 12px; align-items: center; padding: 14px;
    background: #fff; border: 1px solid #d0d7de; border-radius: 8px; margin-bottom: 12px; font-size: 12.5px; }
  .ill-form label { color: #57606a; text-align: right; }
  .ill-field { display: flex; align-items: center; gap: 10px; }
  .ill-input { min-width: 128px; padding: 5px 9px; border: 1px solid #c4ccd5; border-radius: 5px; background: #fff; color: #1f2328; }

  .ill-lan { position: relative; height: 330px; border: 2px dashed #3d4552; border-radius: 14px; background: #161b22; }
  .ill-lan-title { position: absolute; left: 14px; top: 10px; color: #9da7b3; font-size: 12px; font-weight: 600; }
  .ill-lan svg { position: absolute; inset: 0; }
  .ill-node { position: absolute; display: grid; justify-items: center; gap: 2px; width: 168px; padding: 10px 8px;
    border: 1px solid #2f3846; border-radius: 10px; background: #1c232d; text-align: center; }
  .ill-node .icon { font-size: 30px; color: #9da7b3; }
  .ill-node strong { font-size: 13px; }
  .ill-node small { color: #9da7b3; font-size: 11.5px; }
  .ill-node code { font: 600 12px 'JetBrains Mono', Consolas, monospace; color: #f0f3f6; }
  #illustration-shot .ill-node .icon { font-size: 30px; vertical-align: 0; }
  .ill-node.host .icon { color: ${GREEN}; }
  .ill-chip { display: inline-flex; align-items: center; gap: 6px; padding: 7px 11px; border: 1px solid #2f3846;
    border-radius: 999px; background: #1c232d; font-weight: 600; }
  .ill-chip small { color: ${GREEN}; font-weight: 700; }
  .ill-card { padding: 14px; border: 1px solid #2f3846; border-radius: 10px; background: #161b22; }
  .ill-card h5 { margin: 0 0 10px; font-size: 13px; color: #9da7b3; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .ill-spec { display: flex; flex-wrap: wrap; gap: 8px; }
  .ill-spec span { padding: 5px 10px; border-radius: 6px; background: #242c38; font-weight: 600; }

  .ill-console { font-size: 12.5px; }
  .ill-console-top { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 16px; background: #312d2a; color: #fff; font-weight: 700; }
  .ill-crumbs { padding: 10px 18px 0; color: #0b6bcb; font-size: 12px; }
  .ill-console-main { padding: 8px 18px 18px; }
  .ill-console-main h4 { margin: 4px 0 12px; font-size: 18px; font-weight: 600; color: #161513; }
  .ill-section { margin-bottom: 10px; padding: 12px 14px; background: #fff; border: 1px solid #dcdcdc; border-radius: 6px; }
  .ill-section h6 { margin: 0 0 8px; font-size: 13px; color: #161513; }
  .ill-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 3px 0; }
  .ill-row > span:first-child { min-width: 92px; color: #6f6f6f; }
  .ill-badge { padding: 1px 8px; border-radius: 999px; background: #e3f1e6; color: #1e6b31; font-size: 11px; font-weight: 700; }
  .ill-radio { display: inline-flex; align-items: center; gap: 6px; }
  .ill-radio::before { content: ''; width: 12px; height: 12px; border-radius: 50%; border: 4px solid #0b6bcb; background: #fff; }
`;

const icon = (name) => `<span class="material-symbols-outlined icon" aria-hidden="true">${name}</span>`;
const label = (text) => `<span class="ill-label">← ${text}</span>`;
const note = (text) => `<div class="ill-note">${icon('info')}<span>${text}</span></div>`;

function browser(url, body) {
  return `<div class="ill-browser">
    <div class="ill-browser-bar">
      <span><span class="dot" style="background:#ff5f57"></span> <span class="dot" style="background:#febc2e"></span> <span class="dot" style="background:#28c840"></span></span>
      <span class="ill-url">${icon('language')}${url}</span>
    </div>
    ${body}
  </div>`;
}

function routerPanel(pt, main, highlightMenu) {
  const item = (text, extra = '') => `<div class="ill-router-item ${extra}">${text}</div>`;
  const forwarding = pt ? 'Redirecionamento de portas' : 'Port Forwarding';
  return browser('http://192.168.0.1', `<div class="ill-router">
    <aside class="ill-router-menu">
      <div class="ill-router-brand">${icon('router')}${pt ? 'Meu roteador' : 'My router'}</div>
      ${item(`${icon('monitoring')}Status`)}
      ${item(`${icon('lan')}${pt ? 'Rede (LAN)' : 'Network (LAN)'}`)}
      ${item(`${icon('wifi')}Wi-Fi`)}
      ${item(`${icon('expand_more')}${pt ? 'Avançado' : 'Advanced'}`, 'open')}
      ${item('NAT', 'sub')}
      ${highlightMenu ? `<div class="ill-router-item ill-hl">${forwarding}</div>` : item(forwarding, 'sub active')}
      ${item('Virtual Server', 'sub')}
      ${item('DMZ', 'sub')}
      ${item('UPnP', 'sub')}
      ${item(`${icon('shield')}Firewall`)}
      ${item(`${icon('settings')}${pt ? 'Sistema' : 'System'}`)}
    </aside>
    <main class="ill-router-main">${main}</main>
  </div>`);
}

function rulesTable(pt, rows) {
  return `<table class="ill-table">
    <tr><th>${pt ? 'Serviço' : 'Service'}</th><th>${pt ? 'Protocolo' : 'Protocol'}</th><th>${pt ? 'Porta externa' : 'External port'}</th>
      <th>${pt ? 'IP interno' : 'Internal IP'}</th><th>${pt ? 'Porta interna' : 'Internal port'}</th></tr>
    ${rows}
  </table>`;
}

function lan(pt) {
  const node = (x, y, symbol, title, subtitle, address, extra = '') => `
    <div class="ill-node ${extra}" style="left:${x}px; top:${y}px;">
      ${icon(symbol)}<strong>${title}</strong>${subtitle ? `<small>${subtitle}</small>` : ''}<code>${address}</code>
    </div>`;
  // Centers: router 316, devices 98 / 316 / 534 in a 632px wide zone.
  return `<div class="ill-lan">
    <div class="ill-lan-title">${icon('home')} ${pt ? 'Mesma rede local: mesmo Wi-Fi ou mesmo cabo' : 'Same local network: same Wi-Fi or same cable'}</div>
    <svg width="632" height="330" viewBox="0 0 632 330">
      <g stroke="#3d4552" stroke-width="2" fill="none">
        <path d="M316 128 V150 M316 150 H534 M316 150 V176 M534 150 V176" />
      </g>
      <g stroke="${GREEN}" stroke-width="3" fill="none"><path d="M316 150 H98 V176" /></g>
    </svg>
    ${node(232, 36, 'router', pt ? 'Roteador da casa' : 'Home router', '', '192.168.0.1')}
    ${node(14, 176, 'desktop_windows', pt ? 'Seu PC' : 'Your PC', pt ? 'servidor Monky' : 'Monky server', '192.168.0.105', 'host ill-hl')}
    ${node(232, 176, 'laptop_windows', pt ? 'Notebook do amigo' : "Friend's laptop", pt ? 'entra pelo seu IP' : 'joins with your IP', '192.168.0.110')}
    ${node(450, 176, 'computer', pt ? 'PC do amigo' : "Friend's PC", pt ? 'entra pelo seu IP' : 'joins with your IP', '192.168.0.112')}
    <div style="position:absolute; left:14px; top:298px;">${label(pt ? 'Compartilhe este IP com seus amigos' : 'Share this IP with your friends')}</div>
  </div>
  ${note(pt ? 'Sem abrir portas, sem VPN e sem VPS: todos já estão na mesma rede.' : 'No port forwarding, VPN or VPS: everyone is already on the same network.')}`;
}

function routerMenu(pt) {
  const main = `<h4>${pt ? 'Redirecionamento de portas' : 'Port Forwarding'}</h4>
    ${rulesTable(pt, `<tr><td class="empty" colspan="5">${pt ? 'Nenhuma regra cadastrada' : 'No rules yet'}</td></tr>`)}
    <span class="ill-button">${icon('add')}${pt ? 'Adicionar regra' : 'Add rule'}</span>
    <div style="margin-top:22px;">${label(pt ? 'Também pode se chamar Virtual Server ou NAT' : 'It may also be called Virtual Server or NAT')}</div>`;
  return routerPanel(pt, main, true)
    + note(pt ? 'Ilustração: o nome e o lugar do menu mudam conforme a marca e o modelo do roteador.'
      : 'Illustration: the menu name and location change with the router brand and model.');
}

function routerRule(pt) {
  const field = (name, value, callout, highlight = true) => `<label>${name}</label>
    <div class="ill-field"><span class="ill-input${highlight ? ' ill-hl' : ''}">${value}</span>${callout ? label(callout) : ''}</div>`;
  const main = `<h4>${pt ? 'Adicionar regra' : 'Add rule'}</h4>
    <div class="ill-form">
      ${field(pt ? 'Serviço' : 'Service', 'Monky', '', false)}
      ${field(pt ? 'Protocolo' : 'Protocol', 'TCP', '')}
      ${field(pt ? 'Porta externa' : 'External port', '3000', pt ? 'porta do Monky' : 'Monky port')}
      ${field(pt ? 'IP interno' : 'Internal IP', '192.168.0.105', pt ? 'IP do seu PC' : 'your PC IP')}
      ${field(pt ? 'Porta interna' : 'Internal port', '3000', '')}
    </div>
    ${rulesTable(pt, `
      <tr><td>Monky</td><td>TCP</td><td>3000</td><td>192.168.0.105</td><td>3000</td></tr>
      <tr class="ill-hl"><td>Monky SFU</td><td>UDP</td><td>40000-49151</td><td>192.168.0.105</td><td>40000-49151</td></tr>`)}
    <div style="margin-top:12px;">${label(pt ? 'A regra UDP só é necessária no modo SFU' : 'The UDP rule is only needed in SFU mode')}</div>`;
  return routerPanel(pt, main, false)
    + note(pt ? 'Ilustração com endereços de exemplo: use o IP do seu PC e a porta do seu servidor.'
      : 'Illustration with sample addresses: use your PC IP and your server port.');
}

function publicIp(pt) {
  const query = pt ? 'meu ip' : 'what is my ip';
  return browser(`https://busca.example/?q=${encodeURIComponent(query).replace(/%20/g, '+')}`, `
    <div style="padding:20px 22px 26px;">
      <div style="display:flex; align-items:center; gap:10px; max-width:430px; padding:9px 14px; border:1px solid #d0d7de; border-radius:22px; background:#fff;">
        ${icon('search')}<span>${query}</span>
      </div>
      <div style="margin-top:18px; padding:16px 18px; background:#fff; border:1px solid #d0d7de; border-radius:10px;">
        <div style="color:#57606a; font-size:12.5px;">${pt ? 'Seu endereço IP público' : 'Your public IP address'}</div>
        <div style="display:flex; align-items:center; gap:14px; margin-top:6px;">
          <span class="ill-hl" style="padding:2px 8px; font:700 28px 'JetBrains Mono', Consolas, monospace; color:#1f2328;">203.0.113.25</span>
          ${label(pt ? 'Envie este IP aos seus amigos' : 'Send this IP to your friends')}
        </div>
        <div style="margin-top:10px; color:#57606a; font-size:12.5px;">
          ${pt ? 'É o endereço da sua casa na internet, diferente do IP local (192.168.0.105).'
    : 'It is your home address on the internet, different from the local IP (192.168.0.105).'}
        </div>
      </div>
    </div>`)
    + note(pt ? 'Ilustração com IP de exemplo: qualquer site ou busca por "meu IP" mostra o seu.'
      : 'Illustration with a sample IP: any site or a search for "what is my IP" shows yours.');
}

function vpsProviders(pt) {
  const chip = (name, extra = '') => `<span class="ill-chip">${icon('cloud')}${name}${extra ? ` <small>${extra}</small>` : ''}</span>`;
  return `<div class="ill-card">
      <h5>${pt ? 'Qualquer provedor de VPS serve' : 'Any VPS provider works'}</h5>
      <div style="display:flex; flex-wrap:wrap; gap:8px;">
        ${chip('Oracle Cloud', pt ? 'grátis' : 'free')}${chip('Hetzner')}${chip('DigitalOcean')}${chip('Linode')}${chip('Vultr')}
      </div>
    </div>
    <div class="ill-card" style="margin-top:12px;">
      <h5>${pt ? 'Escolha o menor plano' : 'Pick the smallest plan'}</h5>
      <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <div class="ill-spec ill-hl" style="padding:8px;">
          <span>1 vCPU</span><span>1 GB RAM</span><span>Ubuntu / Debian</span><span>${pt ? 'IP público' : 'Public IP'}</span>
        </div>
        ${label(pt ? 'Suficiente para o Monky' : 'Enough for Monky')}
      </div>
    </div>`
    + note(pt ? 'Ilustração: os planos pagos costumam custar de US$ 3 a 5 por mês; a Oracle tem VMs gratuitas.'
      : 'Illustration: paid plans usually cost US$ 3 to 5 per month; Oracle has free VMs.');
}

function oracleConsole(crumbs, title, body) {
  return browser('https://cloud.oracle.com', `<div class="ill-console">
    <div class="ill-console-top">${icon('cloud')}Oracle Cloud</div>
    <div class="ill-crumbs">${crumbs}</div>
    <div class="ill-console-main"><h4>${title}</h4>${body}</div>
  </div>`);
}

function oracleInstance(pt) {
  const row = (name, value) => `<div class="ill-row"><span>${name}</span>${value}</div>`;
  return oracleConsole('Compute › Instances › Create instance', 'Create compute instance', `
    <div class="ill-section"><h6>Name</h6>${row('Name', '<span class="ill-input">monky-server</span>')}</div>
    <div class="ill-section"><h6>Image and shape</h6>
      ${row('Image', '<strong>Canonical Ubuntu 24.04</strong>')}
      ${row('Shape', `<span class="ill-hl" style="padding:2px 8px;"><strong>VM.Standard.E2.1.Micro</strong> <span class="ill-badge">Always Free-eligible</span></span>
        ${label(pt ? 'Escolha um shape Always Free' : 'Pick an Always Free shape')}`)}
    </div>
    <div class="ill-section"><h6>Add SSH keys</h6>
      ${row('', '<span class="ill-radio">Generate a key pair for me</span>')}
      ${row('', `<span class="ill-button secondary ill-hl" style="margin-top:0;">${icon('download')}Save private key</span>
        ${label(pt ? 'Guarde a chave: é com ela que você entra via SSH' : 'Keep this key: you use it to log in over SSH')}`)}
    </div>
    <span class="ill-button" style="margin-top:2px;">Create</span>`)
    + note(pt ? 'Ilustração simplificada do console da Oracle Cloud: os nomes dos campos são os do console em inglês.'
      : 'Simplified illustration of the Oracle Cloud console.');
}

function oracleIngress(pt) {
  return oracleConsole('Networking › Virtual Cloud Networks › vcn-monky › Default Security List', 'Ingress Rules', `
    <span class="ill-button" style="margin:0 0 10px;">Add Ingress Rules</span>
    <table class="ill-table">
      <tr><th>Source</th><th>IP Protocol</th><th>Destination Port Range</th><th>Description</th></tr>
      <tr><td>0.0.0.0/0</td><td>TCP</td><td>22</td><td>SSH</td></tr>
      <tr class="ill-hl"><td>0.0.0.0/0</td><td>TCP</td><td>3000</td><td>Monky</td></tr>
      <tr class="ill-hl"><td>0.0.0.0/0</td><td>UDP</td><td>40000-49151</td><td>Monky SFU</td></tr>
    </table>
    <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
      ${label(pt ? 'TCP 3000: porta do Monky' : 'TCP 3000: Monky port')}
      ${label(pt ? 'UDP 40000-49151: só no modo SFU' : 'UDP 40000-49151: SFU mode only')}
    </div>`)
    + note(pt ? 'Ilustração simplificada do console da Oracle Cloud. Depois, libere as mesmas portas no firewall da VM.'
      : 'Simplified illustration of the Oracle Cloud console. Then open the same ports in the VM firewall.');
}

/** name → HTML, for one language. */
function illustrationSpecs(language) {
  const pt = language === 'pt-BR';
  return {
    'illustration-lan': lan(pt),
    'illustration-router-menu': routerMenu(pt),
    'illustration-router-rule': routerRule(pt),
    'illustration-public-ip': publicIp(pt),
    'illustration-vps-providers': vpsProviders(pt),
    'illustration-oracle-instance': oracleInstance(pt),
    'illustration-oracle-ingress': oracleIngress(pt),
  };
}

/** Runs in the renderer: draws one illustration on top of the page and returns its rectangle. */
async function renderIllustrationShot(style, html) {
  document.querySelector('#illustration-backdrop')?.remove();
  // An opaque backdrop keeps the page underneath from showing at sub-pixel edges.
  const backdrop = document.createElement('div');
  backdrop.id = 'illustration-backdrop';
  Object.assign(backdrop.style, { position: 'fixed', inset: '0', zIndex: '100000', background: '#1e1f22' });
  const root = document.createElement('div');
  root.id = 'illustration-shot';
  root.innerHTML = `<style>${style}</style>${html}`;
  root.style.width = '660px';
  backdrop.appendChild(root);
  document.body.appendChild(backdrop);
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const box = root.getBoundingClientRect();
  return { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) };
}

module.exports = { STYLE, illustrationSpecs, renderIllustrationShot };
