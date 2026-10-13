/**
 * Pictures of the public sites the hosting tutorials send people to (VPN
 * downloads and the Oracle Cloud free tier). The page is captured live, then
 * framed like the other illustrations with the address and a ring on the
 * button to click. Consent banners are hidden, never answered.
 *
 * They need the internet and change whenever the sites do, so they only run
 * with `npm run screenshots:onboarding -- --sites` (or `--sites-only`).
 */

const PAGE = { width: 1000, height: 640 };
const FRAME_WIDTH = 630;

/** One entry per picture: assets/onboarding/<name>-<language>.png. */
const SITE_SHOTS = [
  {
    name: 'site-radmin',
    url: { 'pt-BR': 'https://www.radmin-vpn.com/br/', en: 'https://www.radmin-vpn.com/' },
    target: 'download|baixar',
    label: { 'pt-BR': 'Baixe o instalador gratuito', en: 'Download the free installer' },
  },
  {
    name: 'site-hamachi',
    url: 'https://vpn.net/',
    target: '^download now$',
    label: { 'pt-BR': 'Baixe o Hamachi', en: 'Download Hamachi' },
    englishOnly: true,
  },
  {
    name: 'site-tailscale',
    url: 'https://tailscale.com/download/windows',
    target: 'download tailscale for windows',
    label: { 'pt-BR': 'Baixe o app para Windows', en: 'Download the Windows app' },
    englishOnly: true,
  },
  {
    name: 'site-zerotier',
    url: 'https://www.zerotier.com/download/',
    target: 'msi installer',
    label: { 'pt-BR': 'Instalador para Windows', en: 'Windows installer' },
    englishOnly: true,
  },
  {
    name: 'site-oracle-free',
    url: { 'pt-BR': 'https://www.oracle.com/br/cloud/free/', en: 'https://www.oracle.com/cloud/free/' },
    target: '^(comece já gratuitamente|start for free)$',
    label: { 'pt-BR': 'Crie a conta gratuita', en: 'Create the free account' },
  },
];

function siteUrl(shot, language) {
  return typeof shot.url === 'string' ? shot.url : shot.url[language];
}

/**
 * Runs in the site page: hides scrollbars and consent banners, brings the
 * target into view and returns its rectangle.
 */
async function prepareSitePage(target) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const style = document.createElement('style');
  style.textContent = 'html { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }';
  document.head.appendChild(style);
  for (const element of document.querySelectorAll('body *')) {
    const position = getComputedStyle(element).position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    const text = element.textContent || '';
    if (text.length < 2000 && /cookie|privacy choices|consent/i.test(text)) element.style.setProperty('display', 'none', 'important');
  }
  const pattern = new RegExp(target, 'i');
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return box.width > 20 && box.height > 12 && css.visibility !== 'hidden' && css.display !== 'none';
  };
  const element = [...document.querySelectorAll('a, button')]
    .find((candidate) => pattern.test((candidate.textContent || '').trim().replace(/\s+/g, ' ')) && visible(candidate));
  if (!element) throw new Error(`No button matches /${target}/`);
  let box = element.getBoundingClientRect();
  if (box.bottom > innerHeight - 90) {
    window.scrollTo({ top: window.scrollY + box.top - innerHeight * 0.68, behavior: 'instant' });
    await wait(900);
    box = element.getBoundingClientRect();
  }
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

/** Frame, ring and label around a captured page, in the illustration style. */
function siteShotHtml(shot, language, image, target) {
  const scale = FRAME_WIDTH / PAGE.width;
  const pad = 5;
  const ring = {
    left: Math.round(target.x * scale - pad),
    top: Math.round(target.y * scale - pad),
    width: Math.round(target.width * scale + pad * 2),
    height: Math.round(target.height * scale + pad * 2),
  };
  const height = Math.round(PAGE.height * scale);
  const below = ring.top + ring.height + 30 < height;
  const center = Math.min(Math.max(ring.left + ring.width / 2, 130), FRAME_WIDTH - 130);
  const labelTop = below ? ring.top + ring.height + 8 : ring.top - 28;
  const pt = language === 'pt-BR';
  const address = siteUrl(shot, language).replace(/^https:\/\/(www\.)?/, '');
  const note = shot.englishOnly && pt
    ? `<div class="ill-note"><span class="material-symbols-outlined icon" aria-hidden="true">translate</span><span>O site é em inglês.</span></div>`
    : '';
  return `<div class="ill-browser">
    <div class="ill-browser-bar">
      <span><span class="dot" style="background:#ff5f57"></span> <span class="dot" style="background:#febc2e"></span> <span class="dot" style="background:#28c840"></span></span>
      <span class="ill-url"><span class="material-symbols-outlined icon" aria-hidden="true">lock</span>${address}</span>
    </div>
    <div style="position:relative; width:${FRAME_WIDTH}px; height:${height}px; overflow:hidden;">
      <img src="${image}" style="display:block; width:${FRAME_WIDTH}px; height:${height}px;" alt="">
      <div class="ill-hl" style="position:absolute; left:${ring.left}px; top:${ring.top}px; width:${ring.width}px; height:${ring.height}px; border-radius:10px;"></div>
      <span class="ill-label" style="position:absolute; left:${center}px; top:${labelTop}px; transform:translateX(-50%);">${below ? '↑' : '↓'} ${shot.label[language]}</span>
    </div>
  </div>${note}`;
}

module.exports = { PAGE, SITE_SHOTS, siteUrl, prepareSitePage, siteShotHtml };
