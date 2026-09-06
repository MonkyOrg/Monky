import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import { LruCache } from '@monky/shared';
import { isPrivateAddress, isPrivateHostname } from './privateAddress';

export interface LinkPreviewMetadata {
  url: string;
  title: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
  embedType?: 'youtube' | 'spotify';
  embedUrl?: string;
}

interface HtmlFetchResult {
  html: string;
  finalUrl: string;
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_HTML_BYTES = 50 * 1024;
const MAX_REDIRECTS = 5;
const previewCache = new LruCache<string, LinkPreviewMetadata | null>(200, 1000 * 60 * 60);

/**
 * Checks if a hostname points to localhost, loopback, private RFC 1918 subnets,
 * or cloud metadata/link-local addresses to prevent SSRF vulnerabilities.
 */
function isPrivateOrLocalHost(hostname: string): boolean {
  const lower = (hostname || '').toLowerCase().trim();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.localhost')
  ) {
    return true;
  }

  if (net.isIP(lower)) {
    // IPv4 Loopback (127.0.0.0/8)
    if (lower.startsWith('127.')) return true;
    // IPv4 RFC 1918 Private ranges
    if (lower.startsWith('10.')) return true;
    if (lower.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lower)) return true;
    // IPv4 Link-Local / Cloud Metadata (169.254.0.0/16)
    if (lower.startsWith('169.254.')) return true;
    // IPv4 Broadcast / Any
    if (lower === '0.0.0.0' || lower === '255.255.255.255') return true;
    // IPv6 Loopback / Link-Local / Unique Local (fc00::/7, fe80::/10)
    if (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd')
    ) {
      return true;
    }
  }

  return false;
}

function detectEmbedProvider(url: string): 'youtube' | 'spotify' | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') || u.hostname === 'youtu.be') return 'youtube';
    if (u.hostname.includes('spotify.com')) return 'spotify';
  } catch {}
  return null;
}

function extractSpotifyInfo(url: string): { type: string; id: string } | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/^\/(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/);
    if (match) return { type: match[1], id: match[2] };
  } catch {}
  return null;
}

async function fetchOEmbed(rawUrl: string, provider: 'youtube' | 'spotify'): Promise<LinkPreviewMetadata | null> {
  const endpoint = provider === 'youtube'
    ? `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`
    : `https://open.spotify.com/oembed?url=${encodeURIComponent(rawUrl)}`;

  return await new Promise<LinkPreviewMetadata | null>((resolve) => {
    let settled = false;
    const complete = (result: LinkPreviewMetadata | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = https.get(endpoint, { headers: { 'User-Agent': 'Monky-App' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        complete(null);
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));

          let embedUrl: string | undefined;
          // YouTube is intentionally not embedded: its player rejects the app's
          // file:// origin (errors 152/153), so YouTube links keep the regular
          // rich preview and open in the default browser like any other link
          // (#266).
          if (provider === 'spotify') {
            const info = extractSpotifyInfo(rawUrl);
            if (info) {
              embedUrl = `https://open.spotify.com/embed/${info.type}/${info.id}`;
            }
          }

          complete({
            url: rawUrl,
            title: data.title || '',
            description: data.author_name ? `${data.author_name}` : undefined,
            image: data.thumbnail_url || undefined,
            siteName: data.provider_name || (provider === 'youtube' ? 'YouTube' : 'Spotify'),
            favicon: undefined,
            embedType: embedUrl ? provider : undefined,
            embedUrl,
          });
        } catch {
          complete(null);
        }
      });
      response.on('error', () => complete(null));
    });

    request.setTimeout(FETCH_TIMEOUT_MS, () => request.destroy());
    request.on('error', () => complete(null));
  });
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreviewMetadata | null> {
  const normalizedUrl = normalizeHttpUrl(rawUrl);
  if (!normalizedUrl) return null;

  try {
    const parsed = new URL(normalizedUrl);
    if (isPrivateOrLocalHost(parsed.hostname)) {
      return null;
    }
  } catch {
    return null;
  }

  if (previewCache.has(normalizedUrl)) {
    return previewCache.get(normalizedUrl) ?? null;
  }

  try {
    const provider = detectEmbedProvider(normalizedUrl);
    if (provider) {
      const oembedResult = await fetchOEmbed(normalizedUrl, provider);
      if (oembedResult) {
        previewCache.set(normalizedUrl, oembedResult);
        return oembedResult;
      }
    }

    const htmlResult = await fetchHtml(normalizedUrl);
    if (!htmlResult) {
      previewCache.set(normalizedUrl, null);
      return null;
    }

    const preview = parseLinkPreview(htmlResult.html, htmlResult.finalUrl);
    previewCache.set(normalizedUrl, preview);

    const canonicalUrl = normalizeHttpUrl(preview?.url);
    if (canonicalUrl && canonicalUrl !== normalizedUrl) {
      previewCache.set(canonicalUrl, preview);
    }

    return preview;
  } catch {
    previewCache.set(normalizedUrl, null);
    return null;
  }
}

/**
 * A pré-visualização de link é disparada por qualquer mensagem do chat, inclusive
 * de outra pessoa, e a busca acontece no processo main — sem origem, sem CORS. Sem
 * esta trava, mandar `http://192.168.0.1/…` no chat fazia a máquina de cada um
 * bater na própria rede local (#372).
 *
 * A checagem fica no `lookup` em vez de no hostname porque é o único ponto que vê
 * o endereço realmente usado: um domínio público que resolve para 127.0.0.1 passa
 * por qualquer inspeção feita na string da URL.
 */
const publicOnlyLookup: typeof dns.lookup = ((
  hostname: string,
  options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void
) => {
  const done = typeof options === 'function' ? (options as typeof callback) : callback;
  const lookupOptions = typeof options === 'function' ? {} : (options as dns.LookupOptions);

  dns.lookup(hostname, lookupOptions, (err, address, family) => {
    if (err) {
      done(err);
      return;
    }

    const addresses = Array.isArray(address) ? address : [{ address: address as string, family: family as number }];
    const allowed = addresses.filter((entry) => !isPrivateAddress(entry.address));
    if (allowed.length === 0) {
      done(Object.assign(new Error(`Blocked private address for ${hostname}`), { code: 'EACCES' }));
      return;
    }

    if (Array.isArray(address)) {
      done(null, allowed);
      return;
    }
    done(null, allowed[0].address, allowed[0].family);
  });
}) as typeof dns.lookup;

async function fetchHtml(url: string, redirects = 0): Promise<HtmlFetchResult | null> {
  if (redirects > MAX_REDIRECTS) return null;

  try {
    const parsed = new URL(url);
    if (isPrivateOrLocalHost(parsed.hostname)) {
      return null;
    }
  } catch {
    return null;
  }

  return await new Promise<HtmlFetchResult | null>((resolve) => {
    let settled = false;
    const complete = (result: HtmlFetchResult | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const transport = url.startsWith('https:') ? https : http;
    const request = transport.get(
      url,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Monky-App',
        },
        lookup: publicOnlyLookup,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const locationHeader = response.headers.location;
          const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
          response.resume();

          const redirectUrl = resolveUrl(location, url);
          if (!redirectUrl) {
            complete(null);
            return;
          }

          void fetchHtml(redirectUrl, redirects + 1).then(complete);
          return;
        }

        if (status !== 200) {
          response.resume();
          complete(null);
          return;
        }

        const contentTypeHeader = response.headers['content-type'];
        const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader || '').toLowerCase();
        if (!contentType.includes('text/html')) {
          response.resume();
          complete(null);
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        const finishWithChunks = () => {
          const html = Buffer.concat(chunks, totalBytes).toString('utf8');
          complete({ html, finalUrl: url });
        };

        response.on('data', (chunk: Buffer) => {
          if (settled) return;

          const remainingBytes = MAX_HTML_BYTES - totalBytes;
          if (remainingBytes <= 0) {
            finishWithChunks();
            response.destroy();
            return;
          }

          const slice = chunk.length > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
          if (slice.length > 0) {
            chunks.push(slice);
            totalBytes += slice.length;
          }

          if (totalBytes >= MAX_HTML_BYTES) {
            finishWithChunks();
            response.destroy();
          }
        });

        response.on('end', finishWithChunks);
        response.on('aborted', () => complete(null));
        response.on('error', () => complete(null));
      }
    );

    request.setTimeout(FETCH_TIMEOUT_MS, () => {
      request.destroy(new Error('Link preview timeout'));
    });
    request.on('error', () => complete(null));
  });
}

function parseLinkPreview(html: string, pageUrl: string): LinkPreviewMetadata | null {
  const og = extractOpenGraphData(html);
  if (!og.title && !og.description && !og.image && !og.siteName && !og.url) {
    return null;
  }

  const resolvedUrl = resolveUrl(og.url ?? pageUrl, pageUrl) ?? pageUrl;
  const hostname = safeHostname(resolvedUrl);
  const siteName = og.siteName || hostname;
  const title = og.title || siteName;
  if (!title) return null;

  return {
    url: resolvedUrl,
    title,
    description: og.description || undefined,
    image: resolveUrl(og.image, pageUrl) ?? undefined,
    siteName: siteName || undefined,
    favicon: extractFaviconUrl(html, pageUrl) ?? undefined,
  };
}

function extractOpenGraphData(html: string): Partial<Record<'title' | 'description' | 'image' | 'url' | 'siteName', string>> {
  const preview: Partial<Record<'title' | 'description' | 'image' | 'url' | 'siteName', string>> = {};
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];

  for (const tag of metaTags) {
    const attrs = parseHtmlAttributes(tag);
    const property = (attrs.property || attrs.name || '').toLowerCase();
    const content = cleanHtmlText(attrs.content);
    if (!content) continue;

    switch (property) {
      case 'og:title':
        preview.title ??= content;
        break;
      case 'og:description':
        preview.description ??= content;
        break;
      case 'og:image':
        preview.image ??= content;
        break;
      case 'og:url':
        preview.url ??= content;
        break;
      case 'og:site_name':
        preview.siteName ??= content;
        break;
      default:
        break;
    }
  }

  return preview;
}

function extractFaviconUrl(html: string, pageUrl: string): string | null {
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];

  for (const tag of linkTags) {
    const attrs = parseHtmlAttributes(tag);
    const rel = (attrs.rel || '').toLowerCase();
    if (!/\bicon\b/.test(rel)) continue;

    const resolved = resolveUrl(attrs.href, pageUrl);
    if (resolved) return resolved;
  }

  return null;
}

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(tag)) !== null) {
    const key = match[1]?.toLowerCase();
    if (!key || key === 'meta' || key === 'link') continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeHtmlEntities(value.trim());
  }

  return attrs;
}

function cleanHtmlText(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lowered = entity.toLowerCase();
    switch (lowered) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
      case '#39':
        return '\'';
      default:
        break;
    }

    if (lowered.startsWith('#x')) {
      const codePoint = Number.parseInt(lowered.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (lowered.startsWith('#')) {
      const codePoint = Number.parseInt(lowered.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return match;
  });
}

function normalizeHttpUrl(rawUrl: string | null | undefined): string | null {
  return resolveUrl(rawUrl, undefined);
}

function resolveUrl(rawUrl: string | null | undefined, baseUrl?: string): string | null {
  if (!rawUrl) return null;

  try {
    const resolved = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    // Um IP privado escrito na própria URL nem chega a virar requisição (#372).
    // O caso do domínio que resolve para um endereço interno é barrado depois,
    // no lookup.
    const host = resolved.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) ? isPrivateAddress(host) : isPrivateHostname(host)) {
      return null;
    }

    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}
