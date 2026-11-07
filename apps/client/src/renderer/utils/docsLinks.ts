import { getLanguage, type SupportedLanguage } from '../i18n';

const DOCS_BASE: Readonly<Record<SupportedLanguage, string>> = {
  'pt-BR': 'https://monkyorg.github.io/Monky/',
  en: 'https://monkyorg.github.io/Monky/en/',
};

/** Pages of the documentation the app points to. Anchors differ per language: headings are translated. */
const DOCS_PAGES = {
  /** Friends reaching a server hosted here: VPN, ports and the automatic secure connection (#874, #877). */
  reachServer: {
    'pt-BR': 'criar-seu-servidor#liberar-acesso-pela-internet',
    en: 'criar-seu-servidor#open-access-over-the-internet',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<SupportedLanguage, string>>>>;

export type DocsPage = keyof typeof DOCS_PAGES;

/** The documentation page in the app's language. */
export function docsUrl(page: DocsPage): string {
  const language = getLanguage();
  return DOCS_BASE[language] + DOCS_PAGES[page][language];
}
