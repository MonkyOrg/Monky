// Link preview of the web version (Open Graph): the card WhatsApp, Discord,
// Telegram and social networks show for MONKY_WEB_APP_URL. Only the web build
// uses it; the desktop page has no address to share.
//
// The images in apps/client/web/ come from docs-site/og/gerar.mjs, the same
// generator and template as the documentation's cards. They are served from
// the site root, so the card points at a stable absolute URL.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const images = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const preview = {
  title: 'Monky na web: chat, voz e vídeo no navegador',
  description: 'Use o Monky sem instalar nada: chat, voz, vídeo e compartilhamento de tela em servidores que você ou seu grupo hospeda, sem conta central.',
  imageAlt: 'Mascote do Monky com chat, voz e vídeo direto do navegador.',
};

/** @param {string} siteUrl the web version's public address, MONKY_WEB_APP_URL */
export function webPreviewPlugin(siteUrl) {
  const meta = (key, name, content) => ({ tag: 'meta', attrs: { [key]: name, content }, injectTo: 'head' });
  return {
    name: 'monky-web-preview',
    config: () => ({ publicDir: images }),
    transformIndexHtml: () => [
      meta('name', 'description', preview.description),
      meta('name', 'theme-color', '#5865f2'),
      { tag: 'link', attrs: { rel: 'canonical', href: siteUrl }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'apple-touch-icon', href: './apple-touch-icon.png' }, injectTo: 'head' },
      meta('property', 'og:type', 'website'),
      meta('property', 'og:site_name', 'Monky'),
      meta('property', 'og:locale', 'pt_BR'),
      // Same address in English: the app follows the language chosen in it.
      meta('property', 'og:locale:alternate', 'en_US'),
      meta('property', 'og:url', siteUrl),
      meta('property', 'og:title', preview.title),
      meta('property', 'og:description', preview.description),
      meta('property', 'og:image', new URL('og.jpg', siteUrl).href),
      meta('property', 'og:image:type', 'image/jpeg'),
      meta('property', 'og:image:width', '1200'),
      meta('property', 'og:image:height', '630'),
      meta('property', 'og:image:alt', preview.imageAlt),
      meta('name', 'twitter:card', 'summary_large_image'),
    ],
  };
}
