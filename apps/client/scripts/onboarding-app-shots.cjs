/**
 * Pictures of the VPN apps for the hosting tutorials. The screenshots in
 * scripts/onboarding-app-shots were taken in Windows Sandbox with throwaway
 * networks; account data is redacted and IDs are samples. Here they get the
 * illustration frame, a ring on what the step talks about and a label.
 *
 * Radmin VPN and Hamachi follow the system language, so they have pt-BR and
 * en captures; Tailscale and ZeroTier only exist in English.
 */
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, 'onboarding-app-shots');

/**
 * `rings` use the screenshot's own pixels; `label` sits under the last ring.
 * `scale` shrinks wide browser captures so they fit the 660px frame.
 */
const APP_SHOTS = [
  {
    name: 'app-radmin-create', app: 'Radmin VPN', localized: true,
    parts: [
      { source: 'radmin-menu', rings: [[64, 58, 176, 20]] },
      { source: 'radmin-create', rings: [[112, 40, 236, 84]] },
    ],
    label: { 'pt-BR': 'Escolha um nome e uma senha para a rede', en: 'Pick a name and a password for the network' },
  },
  {
    name: 'app-radmin-join', app: 'Radmin VPN', localized: true,
    parts: [
      { source: 'radmin-menu', rings: [[64, 80, 176, 20]] },
      { source: 'radmin-join', rings: [[106, 66, 236, 58]] },
    ],
    label: { 'pt-BR': 'Seus amigos usam o mesmo nome e senha', en: 'Your friends use the same name and password' },
  },
  {
    name: 'app-radmin-ip', app: 'Radmin VPN', localized: true,
    parts: [{ source: 'radmin-ip', rings: [[84, 95, 104, 16]] }],
    label: { 'pt-BR': 'Seu IP na rede Radmin (26.x.x.x)', en: 'Your IP on the Radmin network (26.x.x.x)' },
  },
  {
    name: 'app-hamachi-create', app: 'Hamachi', localized: true,
    parts: [{ source: 'hamachi-create', rings: [[158, 102, 260, 124]] }],
    label: { 'pt-BR': 'ID da rede e senha', en: 'Network ID and password' },
  },
  {
    name: 'app-hamachi-join', app: 'Hamachi', localized: true,
    parts: [{ source: 'hamachi-join', rings: [[124, 58, 270, 66]] }],
    label: { 'pt-BR': 'Seus amigos digitam o mesmo ID e senha', en: 'Your friends type the same ID and password' },
  },
  {
    name: 'app-hamachi-ip', app: 'Hamachi', localized: true,
    parts: [{ source: 'hamachi-ip', rings: [[50, 76, 88, 20]] }],
    label: { 'pt-BR': 'Seu IP no Hamachi (25.x.x.x)', en: 'Your Hamachi IP (25.x.x.x)' },
  },
  {
    name: 'app-tailscale-keys', app: 'Tailscale',
    parts: [
      { source: 'tailscale-keys', scale: 0.62, rings: [[660, 192, 154, 36]] },
      { source: 'tailscale-auth-key', scale: 0.62, rings: [[16, 166, 480, 50], [372, 656, 120, 40]] },
    ],
    label: { 'pt-BR': 'Marque Reusable para vários amigos usarem a mesma chave', en: 'Turn on Reusable so several friends can use the same key' },
  },
  {
    name: 'app-tailscale-ip', app: 'Tailscale',
    parts: [{ source: 'tailscale-device-ip', rings: [[28, 106, 238, 20]] }],
    label: { 'pt-BR': 'This device: o IP 100.x.x.x deste computador', en: 'This device: the 100.x.x.x IP of this computer' },
  },
  {
    name: 'app-zerotier-create', app: 'ZeroTier',
    parts: [
      { source: 'zerotier-create', scale: 0.6, rings: [[740, 572, 150, 46]] },
      { source: 'zerotier-network-id', scale: 0.6, rings: [[24, 44, 230, 26]] },
    ],
    label: { 'pt-BR': 'O Network ID é o código que seus amigos usam', en: 'The Network ID is the code your friends use' },
  },
  {
    name: 'app-zerotier-join', app: 'ZeroTier',
    parts: [
      { source: 'zerotier-join', rings: [[10, 64, 332, 28]] },
      { source: 'zerotier-authorize', scale: 0.62, rings: [[536, 44, 130, 44], [280, 498, 150, 34]] },
    ],
    label: { 'pt-BR': 'Autorize cada amigo no painel', en: 'Authorize each friend in the panel' },
  },
  {
    name: 'app-zerotier-ip', app: 'ZeroTier',
    parts: [{ source: 'zerotier-ip', scale: 0.85, rings: [[362, 242, 176, 26]] }],
    label: { 'pt-BR': 'Seu IP na rede ZeroTier', en: 'Your IP on the ZeroTier network' },
  },
];

function sourcePath(source, language, localized) {
  return path.join(SOURCE_DIR, localized ? `${source}-${language}.png` : `${source}.png`);
}

function pngSize(file) {
  const header = fs.readFileSync(file).subarray(16, 24);
  return [header.readUInt32BE(0), header.readUInt32BE(4)];
}

/** HTML for one framed picture, in the illustration style. */
function appShotHtml(shot, language) {
  const parts = shot.parts.map((part) => {
    const file = sourcePath(part.source, language, shot.localized);
    const [width, height] = pngSize(file);
    const scale = part.scale ?? 1;
    const data = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    const rings = part.rings.map(([x, y, w, h]) => `<div class="ill-hl" style="position:absolute; left:${Math.round(x * scale) - 3}px;
      top:${Math.round(y * scale) - 3}px; width:${Math.round(w * scale) + 6}px; height:${Math.round(h * scale) + 6}px;"></div>`).join('');
    return `<div style="position:relative; flex:0 0 auto; width:${Math.round(width * scale)}px; height:${Math.round(height * scale)}px;
        border-radius:8px; overflow:visible; box-shadow:0 10px 26px rgba(0,0,0,.45);">
      <img src="${data}" alt="" style="display:block; width:100%; height:100%; border-radius:8px;">
      ${rings}
    </div>`;
  });
  const arrow = '<span class="material-symbols-outlined icon" aria-hidden="true" style="font-size:24px; color:#9da7b3;">arrow_downward</span>';
  return `<div class="ill-card" style="display:grid; gap:12px; justify-items:center; padding:16px 14px;">
    <div style="justify-self:start; display:flex; align-items:center; gap:8px; color:#9da7b3; font-size:12px; font-weight:600;">
      <span class="material-symbols-outlined icon" aria-hidden="true">vpn_lock</span>${shot.app}
    </div>
    <div style="display:flex; flex-direction:column; align-items:center; gap:8px;">${parts.join(arrow)}</div>
    <span class="ill-label">↑ ${shot.label[language]}</span>
  </div>`;
}

module.exports = { APP_SHOTS, appShotHtml };
