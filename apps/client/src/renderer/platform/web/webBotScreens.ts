import {
  BOT_SCREEN_DOCUMENT_MAX_BYTES, MINIAPP_LOADER_MESSAGES, MINIAPP_LOADER_PAGE, botScreenDocumentConsentSchema,
  type BotScreenDocumentConsent,
} from '@monky/shared';
import type { BotScreenDocumentHost } from '../api';

/**
 * Bot miniapps on the web (#858). The app's own origin and CSP must never run a
 * miniapp, so its frame loads a page of the miniapps site, which asks the app
 * for the document and writes it into itself. The document is handed over once,
 * only to a miniapp frame of this page and only to the origin it was made for.
 */
interface PendingDocument {
  token: string;
  /** The loader's origin as seen in its messages: its own, or "null" when opaque. */
  origin: string;
  html: string | null;
}

const MAX_DOCUMENTS = 2;
const documents = new Map<string, PendingDocument>();
let listening = false;

function miniappsBase(): string {
  return __MONKY_MINIAPPS_URL__;
}

/** A host with `{id}` gives each document its own subdomain, hence its own origin. */
export function webBotScreenDocumentHost(): BotScreenDocumentHost {
  return { isolation: miniappsBase().includes('{id}') ? 'origin' : 'opaque', loaderLoads: 1 };
}

function documentUrl(token: string): { url: string; origin: string } {
  const base = miniappsBase();
  if (base.includes('{id}')) {
    const page = new URL(MINIAPP_LOADER_PAGE, base.replace('{id}', token));
    return { url: page.href, origin: page.origin };
  }
  return { url: `${new URL(MINIAPP_LOADER_PAGE, base).href}#${token}`, origin: 'null' };
}

function isMiniappFrame(source: MessageEventSource): source is WindowProxy {
  if (source instanceof MessagePort || (typeof ServiceWorker !== 'undefined' && source instanceof ServiceWorker)) return false;
  return Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe.bot-screen-frame'))
    .some((frame) => frame.contentWindow === source);
}

const deliver = (event: MessageEvent<unknown>): void => {
  const data = event.data;
  if (!event.source || typeof data !== 'object' || data === null || !('type' in data) || !('token' in data) ||
      data.type !== MINIAPP_LOADER_MESSAGES.ready || typeof data.token !== 'string') return;
  const entry = [...documents.values()].find((candidate) => candidate.token === data.token);
  if (!entry || entry.html === null || event.origin !== entry.origin || !isMiniappFrame(event.source)) return;
  const html = entry.html;
  // Once: a page the miniapp navigates to later cannot ask for it again.
  entry.html = null;
  event.source.postMessage({ type: MINIAPP_LOADER_MESSAGES.document, token: entry.token, html },
    entry.origin === 'null' ? '*' : entry.origin);
};

export function createWebBotScreenDocument(html: string, consent: BotScreenDocumentConsent): Promise<string> {
  if (typeof html !== 'string' || !html || new TextEncoder().encode(html).byteLength > BOT_SCREEN_DOCUMENT_MAX_BYTES) {
    return Promise.reject(new Error('Invalid miniapp document request.'));
  }
  if (!botScreenDocumentConsentSchema.safeParse(consent).success) {
    return Promise.reject(new Error('Current, instance-bound miniapp consent is required.'));
  }
  if (documents.size >= MAX_DOCUMENTS) return Promise.reject(new Error('Close another miniapp before opening this one.'));
  const token = crypto.randomUUID();
  const { url, origin } = documentUrl(token);
  documents.set(url, { token, origin, html });
  if (!listening) {
    listening = true;
    window.addEventListener('message', deliver);
  }
  return Promise.resolve(url);
}

export function removeWebBotScreenDocument(url: string): Promise<void> {
  documents.delete(url);
  if (documents.size === 0 && listening) {
    listening = false;
    window.removeEventListener('message', deliver);
  }
  return Promise.resolve();
}
