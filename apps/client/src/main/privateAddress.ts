import net from 'net';

/**
 * Endereços que só existem dentro da máquina ou da rede local. A pré-visualização
 * de link busca URLs que vieram do chat — de qualquer pessoa no servidor — e a
 * busca roda no processo main, sem origem e sem CORS. Sem esta lista, uma
 * mensagem com `http://192.168.0.1/…` fazia a máquina de cada participante bater
 * na própria rede interna (#372).
 */

/** Nomes que resolvem para a própria máquina ou para a rede local por convenção. */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
}

export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  // Não é IP: quem chama já tratou o hostname.
  return false;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts;

  if (a === 0) return true;                          // 0.0.0.0/8 — "esta rede"
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local, inclui metadata de nuvem
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 192 && b === 0) return true;             // 192.0.0.0/24 — uso especial
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                         // multicast e reservado

  return false;
}

function isPrivateIPv6(address: string): boolean {
  const host = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];

  if (host === '::' || host === '::1') return true;

  // IPv4 mapeado (::ffff:192.168.0.1) herda a decisão da versão 4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return isPrivateIPv4(mapped[1]);

  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 unique local
  if (host.startsWith('ff')) return true; // multicast

  return false;
}
