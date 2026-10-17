import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type HeadConfig, type PageData } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const SITE_URL = 'https://monkyorg.github.io/Monky/';
const SITE_NAME = 'Monky';

const descriptions = {
  pt: 'Chat, voz, vídeo e compartilhamento de tela em servidores que você ou seu grupo hospeda, sem conta central. Guias do aplicativo, servidores e SDK de bots.',
  en: 'Chat, voice, video and screen sharing on servers you or your group host, with no central account. App guides, servers and the bot SDK.',
};

/** Imagens de `public/og/`, geradas por `og/gerar.mjs`: uma por seção e idioma. */
function previewSection(page: string): 'home' | 'download' | 'bots' | 'guias' {
  if (page === 'index') return 'home';
  if (page === 'download' || page === 'instalacao') return 'download';
  if (page.startsWith('bots-')) return 'bots';
  return 'guias';
}

const previewAlt = {
  home: { pt: 'Mascote do Monky com chat, voz, tela e bots.', en: 'Monky mascot with chat, voice, screen and bots.' },
  download: { pt: 'Mascote do Monky com o download para Windows e macOS.', en: 'Monky mascot with the Windows and macOS download.' },
  guias: { pt: 'Mascote do Monky com os guias para usar e hospedar.', en: 'Monky mascot with the guides to use and host it.' },
  bots: { pt: 'Mascote do Monky com um exemplo do SDK de bots.', en: 'Monky mascot with a bot SDK example.' },
};

function pageUrl(relativePath: string): string {
  return SITE_URL + relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html');
}

/**
 * Card de WhatsApp, Discord, Telegram e redes sociais (Open Graph). Sem isso
 * cada app inventava a prévia a partir do `<title>`, e a home aparecia como
 * "Documentação". Páginas que declaram o próprio Open Graph no frontmatter,
 * como o convite, ficam com o delas.
 */
function previewHead(pageData: PageData, siteTitle: string, srcDir: string): HeadConfig[] {
  const { frontmatter, relativePath } = pageData;
  const declared = (frontmatter.head ?? []) as HeadConfig[];
  if (declared.some(([, attrs]) => typeof attrs?.property === 'string' && attrs.property.startsWith('og:'))) return [];

  const english = relativePath.startsWith('en/');
  const lang = english ? 'en' : 'pt';
  const page = relativePath.replace(/^en\//, '').replace(/\.md$/, '');
  const section = previewSection(page.replace(/\/index$/, ''));
  const template = frontmatter.titleTemplate;
  const title = typeof template === 'string' ? `${pageData.title} | ${template}`
    : pageData.title === siteTitle || template === false ? pageData.title : `${pageData.title} | ${siteTitle}`;
  const description = pageData.description || descriptions[lang];
  const url = pageUrl(relativePath);
  const image = `${SITE_URL}og/${section}-${lang}.jpg`;

  const head: HeadConfig[] = [
    ['link', { rel: 'canonical', href: url }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: SITE_NAME }],
    ['meta', { property: 'og:locale', content: english ? 'en_US' : 'pt_BR' }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:title', content: title }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:image', content: image }],
    ['meta', { property: 'og:image:type', content: 'image/jpeg' }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: previewAlt[section][lang] }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ];

  // Só aponta a tradução quando ela existe, para não anunciar uma página 404.
  const ptPath = relativePath.replace(/^en\//, '');
  const enPath = `en/${ptPath}`;
  if (existsSync(resolve(srcDir, ptPath)) && existsSync(resolve(srcDir, enPath))) {
    head.push(
      ['meta', { property: 'og:locale:alternate', content: english ? 'pt_BR' : 'en_US' }],
      ['link', { rel: 'alternate', hreflang: 'pt-BR', href: pageUrl(ptPath) }],
      ['link', { rel: 'alternate', hreflang: 'en', href: pageUrl(enPath) }],
      ['link', { rel: 'alternate', hreflang: 'x-default', href: pageUrl(ptPath) }],
    );
  }
  return head;
}

const ptSidebar = [
  {
    text: 'Começar',
    items: [
      { text: 'Início', link: '/' },
      { text: 'Download', link: '/download' },
      { text: 'Primeiros Passos', link: '/primeiros-passos' },
      { text: 'Perguntas frequentes', link: '/faq' },
      { text: 'O que o Monky oferece', link: '/recursos' },
    ],
  },
  {
    text: 'Usar o Monky',
    items: [
      { text: 'Entrar em um servidor', link: '/entrar-em-um-servidor' },
      { text: 'Amigos e mensagens diretas', link: '/amigos-e-mensagens-diretas' },
      { text: 'Conversas, voz e mídia', link: '/usando-o-app' },
      { text: 'Configurações', link: '/configuracoes' },
      { text: 'Usar bots', link: '/bots' },
      { text: 'Solução de problemas', link: '/solucao-de-problemas' },
    ],
  },
  {
    text: 'Administrar um servidor',
    collapsed: true,
    items: [
      { text: 'Criar pelo aplicativo', link: '/criar-seu-servidor' },
      { text: 'Canais, cargos e permissões', link: '/administrar-servidor' },
      { text: 'Hospedar em VPS', link: '/hospedar-em-vps' },
      { text: 'Relay TURN', link: '/turn' },
      { text: 'Monky CLI', link: '/cli' },
    ],
  },
  {
    text: 'Desenvolver bots',
    collapsed: true,
    items: [
      { text: 'Seu primeiro bot', link: '/bots-desenvolvimento' },
      { text: 'Conexão e identidade', link: '/bots-conexao' },
      { text: 'Capacidades e permissões', link: '/bots-permissoes' },
      { text: 'Comandos e autocomplete', link: '/bots-comandos' },
      { text: 'Formulários e mensagens', link: '/bots-interacoes' },
      { text: 'Configurações do bot', link: '/bots-configuracao' },
      { text: 'Prévias e downloads de áudio', link: '/bots-audio' },
      { text: 'Publicar e receber voz', link: '/bots-voz' },
      { text: 'Execução no cliente', link: '/bots-execucao-local' },
      { text: 'Miniapps compartilhados', link: '/bots-miniapps' },
      { text: 'Armazenamento do bot', link: '/bots-armazenamento' },
      { text: 'Empacotar e distribuir', link: '/bots-distribuicao' },
    ],
  },
  {
    text: 'Referência do SDK de bots',
    collapsed: true,
    items: [
      { text: 'Métodos, eventos e ciclo de vida', link: '/bots-api' },
      { text: 'BotClient e contextos', link: '/bots-api-cliente' },
      { text: 'Comandos e interações', link: '/bots-api-interacoes' },
      { text: 'Mídia e execução local', link: '/bots-api-midia' },
      { text: 'CLI, utilitários e constantes', link: '/bots-api-ferramentas' },
    ],
  },
  {
    text: 'Sobre o projeto',
    collapsed: true,
    items: [
      { text: 'Arquitetura', link: '/arquitetura' },
      { text: 'Verificar releases', link: '/verificar-releases' },
    ],
  },
];

const enSidebar = [
  {
    text: 'Get started',
    items: [
      { text: 'Home', link: '/en/' },
      { text: 'Download', link: '/en/download' },
      { text: 'Getting Started', link: '/en/primeiros-passos' },
      { text: 'FAQ', link: '/en/faq' },
      { text: 'What Monky offers', link: '/en/recursos' },
    ],
  },
  {
    text: 'Use Monky',
    items: [
      { text: 'Join a server', link: '/en/entrar-em-um-servidor' },
      { text: 'Friends and direct messages', link: '/en/amigos-e-mensagens-diretas' },
      { text: 'Chat, voice and media', link: '/en/usando-o-app' },
      { text: 'Settings', link: '/en/configuracoes' },
      { text: 'Use bots', link: '/en/bots' },
      { text: 'Troubleshooting', link: '/en/solucao-de-problemas' },
    ],
  },
  {
    text: 'Manage a server',
    collapsed: true,
    items: [
      { text: 'Create in the app', link: '/en/criar-seu-servidor' },
      { text: 'Channels, roles and permissions', link: '/en/administrar-servidor' },
      { text: 'Host on a VPS', link: '/en/hospedar-em-vps' },
      { text: 'TURN Relay', link: '/en/turn' },
      { text: 'Monky CLI', link: '/en/cli' },
    ],
  },
  {
    text: 'Develop bots',
    collapsed: true,
    items: [
      { text: 'Your first bot', link: '/en/bots-desenvolvimento' },
      { text: 'Connection and identity', link: '/en/bots-conexao' },
      { text: 'Capabilities and permissions', link: '/en/bots-permissoes' },
      { text: 'Commands and autocomplete', link: '/en/bots-comandos' },
      { text: 'Forms and messages', link: '/en/bots-interacoes' },
      { text: 'Bot settings', link: '/en/bots-configuracao' },
      { text: 'Audio previews and downloads', link: '/en/bots-audio' },
      { text: 'Publish and receive voice', link: '/en/bots-voz' },
      { text: 'Client-side execution', link: '/en/bots-execucao-local' },
      { text: 'Shared miniapps', link: '/en/bots-miniapps' },
      { text: 'Bot storage', link: '/en/bots-armazenamento' },
      { text: 'Package and distribute', link: '/en/bots-distribuicao' },
    ],
  },
  {
    text: 'Bot SDK reference',
    collapsed: true,
    items: [
      { text: 'Methods, events and lifecycle', link: '/en/bots-api' },
      { text: 'BotClient and contexts', link: '/en/bots-api-cliente' },
      { text: 'Commands and interactions', link: '/en/bots-api-interacoes' },
      { text: 'Media and local execution', link: '/en/bots-api-midia' },
      { text: 'CLI, utilities and constants', link: '/en/bots-api-ferramentas' },
    ],
  },
  {
    text: 'About the project',
    collapsed: true,
    items: [
      { text: 'Architecture', link: '/en/arquitetura' },
      { text: 'Verify releases', link: '/en/verificar-releases' },
    ],
  },
];

export default withMermaid(defineConfig({
  title: SITE_NAME,
  description: descriptions.pt,
  base: '/Monky/',
  transformHead: ({ pageData, siteConfig }) => previewHead(pageData, siteConfig.site.title, siteConfig.srcDir),
  head: [
    ['link', { rel: 'icon', href: '/Monky/logo.png' }],
    ['meta', { name: 'theme-color', content: '#5865f2' }],
    ['script', {}, `
(function() {
  var b = '/Monky/', p = location.pathname;
  // Crawlers indexam com navigator.language = en-US e sem localStorage, o que
  // faria o Googlebot ver um redirect em toda página PT e invalidar o hreflang.
  var isBot = /bot|crawl|spider|slurp|bingpreview|duckduckbot|baiduspider|yandex|facebookexternalhit|embedly|quora link preview|showyoubot|outbrain|pinterest|whatsapp|telegrambot|discordbot|lighthouse|headlesschrome/i
    .test(navigator.userAgent || '');
  // Preserve the language of explicit anchors: translated headings have different IDs.
  if (!isBot && !location.hash && !localStorage.getItem('monky-lang-manual')) {
    var isEn = p.startsWith(b + 'en/') || p === b + 'en';
    var wantsPt = (navigator.language || '').startsWith('pt');
    if (wantsPt && isEn) { location.replace(b + p.slice(b.length + 3) + location.search); return; }
    if (!wantsPt && !isEn && p.startsWith(b)) { location.replace(b + 'en/' + p.slice(b.length) + location.search); return; }
  }
  document.addEventListener('click', function(e) {
    if (e.target.closest && e.target.closest('.translations')) {
      localStorage.setItem('monky-lang-manual', '1');
    }
  });
})();
`],
  ],

  locales: {
    root: {
      label: 'Português',
      lang: 'pt-BR',
      themeConfig: {
        sidebar: ptSidebar,
        nav: [
          { text: 'Guias', link: '/primeiros-passos' },
          { text: 'FAQ', link: '/faq' },
          { text: 'Servidores', link: '/criar-seu-servidor' },
          { text: 'SDK de bots', link: '/bots-desenvolvimento' },
          { text: 'Download', link: '/download' },
          { text: 'Apoiar ☕', link: 'https://buymeacoffee.com/monkyorg' },
        ],
        outline: { label: 'Nesta página' },
        docFooter: { prev: 'Anterior', next: 'Próxima' },
        darkModeSwitchLabel: 'Tema',
        lightModeSwitchTitle: 'Usar tema claro',
        darkModeSwitchTitle: 'Usar tema escuro',
        sidebarMenuLabel: 'Menu',
        returnToTopLabel: 'Voltar ao topo',
        langMenuLabel: 'Idioma',
        skipToContentLabel: 'Pular para o conteúdo',
        editLink: {
          pattern: 'https://github.com/MonkyOrg/Monky/edit/main/docs-site/:path',
          text: 'Editar esta página no GitHub',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en',
      description: descriptions.en,
      themeConfig: {
        sidebar: enSidebar,
        nav: [
          { text: 'Guides', link: '/en/primeiros-passos' },
          { text: 'FAQ', link: '/en/faq' },
          { text: 'Servers', link: '/en/criar-seu-servidor' },
          { text: 'Bot SDK', link: '/en/bots-desenvolvimento' },
          { text: 'Download', link: '/en/download' },
          { text: 'Donate ☕', link: 'https://buymeacoffee.com/monkyorg' },
        ],
        editLink: {
          pattern: 'https://github.com/MonkyOrg/Monky/edit/main/docs-site/:path',
          text: 'Edit this page on GitHub',
        },
      },
    },
  },

  /**
   * Hoje nenhuma página tem bloco mermaid: os diagramas da arquitetura são SVGs
   * gerados fora do site (`docs-site/diagramas/`). O padrão `useMaxWidth: true`
   * encolhia todo diagrama mais largo que a coluna de texto do VitePress
   * (~624px) até o texto ficar ilegível, que é o que a #349 relatava.
   *
   * A configuração fica para um bloco mermaid escrito amanhã não nascer com o
   * mesmo defeito. O `theme` fica de fora de propósito: o plugin troca sozinho
   * para o tema escuro quando a página está no escuro, e fixar um valor aqui
   * quebraria isso.
   */
  mermaid: {
    // O componente do plugin substitui os padrões dele pelo que vier daqui,
    // então estes dois precisam ser repetidos.
    startOnLoad: false,
    securityLevel: 'loose',
    themeVariables: {
      fontSize: '16px',
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    },
    flowchart: { useMaxWidth: false, htmlLabels: true, nodeSpacing: 45, rankSpacing: 55, padding: 12 },
    sequence: { useMaxWidth: false },
  },

  themeConfig: {
    logo: '/logo.png',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/MonkyOrg/Monky' },
    ],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: 'Pesquisar', buttonAriaLabel: 'Pesquisar na documentação' },
              modal: {
                noResultsText: 'Nenhum resultado para',
                displayDetails: 'Mostrar detalhes dos resultados',
                resetButtonTitle: 'Limpar pesquisa',
                backButtonTitle: 'Fechar pesquisa',
                footer: {
                  selectText: 'selecionar',
                  selectKeyAriaLabel: 'tecla Enter',
                  navigateText: 'navegar',
                  navigateUpKeyAriaLabel: 'seta para cima',
                  navigateDownKeyAriaLabel: 'seta para baixo',
                  closeText: 'fechar',
                  closeKeyAriaLabel: 'tecla Esc',
                },
              },
            },
          },
        },
      },
    },
  },
}));
