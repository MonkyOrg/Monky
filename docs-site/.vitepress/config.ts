import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const ptSidebar = [
  {
    text: 'Guia',
    items: [
      { text: 'Início', link: '/' },
      { text: 'Download', link: '/download' },
      { text: 'Primeiros Passos', link: '/primeiros-passos' },
    ],
  },
  {
    text: 'Uso',
    items: [
      { text: 'Criar Seu Servidor', link: '/criar-seu-servidor' },
      { text: 'Entrar Em Um Servidor', link: '/entrar-em-um-servidor' },
      { text: 'Usando o App', link: '/usando-o-app' },
      { text: 'Configurações', link: '/configuracoes' },
    ],
  },
  {
    text: 'Avançado',
    items: [
      { text: 'Hospedar em VPS', link: '/hospedar-em-vps' },
      { text: 'Relay TURN', link: '/turn' },
      { text: 'Monky CLI', link: '/cli' },
      { text: 'Bots', link: '/bots' },
      { text: 'Verificar Releases', link: '/verificar-releases' },
    ],
  },
  {
    text: 'Referência',
    items: [
      { text: 'Recursos', link: '/recursos' },
      { text: 'Arquitetura', link: '/arquitetura' },
      { text: 'Solução de Problemas', link: '/solucao-de-problemas' },
    ],
  },
];

const enSidebar = [
  {
    text: 'Guide',
    items: [
      { text: 'Home', link: '/en/' },
      { text: 'Download', link: '/en/download' },
      { text: 'Getting Started', link: '/en/primeiros-passos' },
    ],
  },
  {
    text: 'Usage',
    items: [
      { text: 'Create Your Server', link: '/en/criar-seu-servidor' },
      { text: 'Join a Server', link: '/en/entrar-em-um-servidor' },
      { text: 'Using the App', link: '/en/usando-o-app' },
      { text: 'Settings', link: '/en/configuracoes' },
    ],
  },
  {
    text: 'Advanced',
    items: [
      { text: 'Host on a VPS', link: '/en/hospedar-em-vps' },
      { text: 'TURN Relay', link: '/en/turn' },
      { text: 'Monky CLI', link: '/en/cli' },
      { text: 'Bots', link: '/en/bots' },
      { text: 'Verify Releases', link: '/en/verificar-releases' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'Features', link: '/en/recursos' },
      { text: 'Architecture', link: '/en/arquitetura' },
      { text: 'Troubleshooting', link: '/en/solucao-de-problemas' },
    ],
  },
];

export default withMermaid(defineConfig({
  title: 'Monky',
  description: 'Voz, vídeo, tela e chat entre amigos — no seu próprio servidor.',
  base: '/Monky/',
  head: [
    ['link', { rel: 'icon', href: '/Monky/logo.png' }],
    ['script', {}, `
(function() {
  var b = '/Monky/', p = location.pathname;
  // Crawlers indexam com navigator.language = en-US e sem localStorage, o que
  // faria o Googlebot ver um redirect em toda página PT e invalidar o hreflang.
  var isBot = /bot|crawl|spider|slurp|bingpreview|duckduckbot|baiduspider|yandex|facebookexternalhit|embedly|quora link preview|showyoubot|outbrain|pinterest|whatsapp|telegrambot|discordbot|lighthouse|headlesschrome/i
    .test(navigator.userAgent || '');
  if (!isBot && !localStorage.getItem('monky-lang-manual')) {
    var isEn = p.startsWith(b + 'en/') || p === b + 'en';
    var wantsPt = (navigator.language || '').startsWith('pt');
    if (wantsPt && isEn) { location.replace(b + p.slice(b.length + 3)); return; }
    if (!wantsPt && !isEn && p.startsWith(b)) { location.replace(b + 'en/' + p.slice(b.length)); return; }
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
          { text: 'Guia', link: '/' },
          { text: 'Download', link: '/download' },
          { text: 'Apoiar ☕', link: 'https://buymeacoffee.com/monkyorg' },
        ],
        outline: { label: 'Nesta página' },
        docFooter: { prev: 'Anterior', next: 'Próxima' },
        darkModeSwitchLabel: 'Tema',
        sidebarMenuLabel: 'Menu',
        returnToTopLabel: 'Voltar ao topo',
        langMenuLabel: 'Idioma',
        editLink: {
          pattern: 'https://github.com/MonkyOrg/Monky/edit/main/docs-site/:path',
          text: 'Editar esta página no GitHub',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en',
      description: 'Voice, video, screen sharing and chat with friends — on your own server.',
      themeConfig: {
        sidebar: enSidebar,
        nav: [
          { text: 'Guide', link: '/en/' },
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
    },
  },
}));
