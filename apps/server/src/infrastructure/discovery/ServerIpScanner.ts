import os from 'os';
import { PUBLIC_IP_INTERFACE_NAME, ServerNetworkInterface } from '@monky/shared';

let cachedPublicIp: string | null = null;
let lastPublicIpFetch = 0;
const PUBLIC_IP_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Attempts to retrieve the public IP of the server host.
 * Caches the result to avoid redundant network calls.
 */
export async function getPublicIp(): Promise<string | null> {
  const now = Date.now();
  if (cachedPublicIp && now - lastPublicIpFetch < PUBLIC_IP_CACHE_TTL_MS) {
    return cachedPublicIp;
  }

  const providers = [
    'https://api.ipify.org?format=json',
    'https://api4.my-ip.io/v2/ip.json',
  ];

  for (const url of providers) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data: any = await res.json();
        const ip = data.ip || data.ipAddress;
        if (ip && typeof ip === 'string' && ip.length >= 7) {
          cachedPublicIp = ip;
          lastPublicIpFetch = now;
          return ip;
        }
      }
    } catch {
      // Try next provider
    }
  }

  return cachedPublicIp;
}

/**
 * Classifies a network interface name and IP into Public, VPN, LAN, or Loopback.
 */
function classifyInterface(name: string, address: string, internal: boolean): { type: 'public' | 'lan' | 'vpn' | 'loopback'; description: string } {
  const lowerName = name.toLowerCase();

  if (internal || address === '127.0.0.1' || address === '::1') {
    return {
      type: 'loopback',
      description: 'Localhost (Apenas neste computador)',
    };
  }

  // VPN check by interface name or IP range
  if (
    lowerName.includes('radmin') ||
    lowerName.includes('hamachi') ||
    lowerName.includes('zerotier') ||
    lowerName.includes('tailscale') ||
    lowerName.includes('wireguard') ||
    lowerName.includes('wg') ||
    lowerName.includes('tun') ||
    lowerName.includes('tap') ||
    lowerName.includes('vpn') ||
    address.startsWith('26.') || // Radmin VPN default range
    address.startsWith('25.')    // Hamachi default range
  ) {
    let vpnLabel = 'VPN / Rede Virtual';
    if (lowerName.includes('radmin') || address.startsWith('26.')) vpnLabel = 'Radmin VPN';
    else if (lowerName.includes('hamachi') || address.startsWith('25.')) vpnLabel = 'Hamachi VPN';
    else if (lowerName.includes('tailscale')) vpnLabel = 'Tailscale';
    else if (lowerName.includes('zerotier')) vpnLabel = 'ZeroTier';

    return {
      type: 'vpn',
      description: `${vpnLabel} (${name})`,
    };
  }

  // LAN check (Private IPv4 ranges: 192.168.x.x, 10.x.x.x, 172.16.x.x - 172.31.x.x)
  if (
    address.startsWith('192.168.') ||
    address.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(address)
  ) {
    let lanLabel = 'Rede Local (LAN)';
    if (lowerName.includes('wi-fi') || lowerName.includes('wlan') || lowerName.includes('wireless')) {
      lanLabel = 'Rede Local (Wi-Fi)';
    } else if (lowerName.includes('ethernet') || lowerName.includes('eth') || lowerName.includes('en')) {
      lanLabel = 'Rede Local (Cabo Ethernet)';
    }

    return {
      type: 'lan',
      description: `${lanLabel} (${name})`,
    };
  }

  return {
    type: 'public',
    description: `Rede Externa (${name})`,
  };
}

/**
 * Scans all network interfaces available on the server and returns them ordered for inviting users.
 */
export async function scanServerNetworkInterfaces(publicIpOverride?: string | null): Promise<ServerNetworkInterface[]> {
  const result: ServerNetworkInterface[] = [];
  const interfaces = os.networkInterfaces();

  // 1. Fetch public IP (if not provided)
  const publicIp = publicIpOverride !== undefined ? publicIpOverride : await getPublicIp();
  if (publicIp) {
    result.push({
      name: PUBLIC_IP_INTERFACE_NAME,
      address: publicIp,
      family: 'IPv4',
      type: 'public',
      description: 'IP Público (Para amigos em outra internet com portas liberadas)',
    });
  }

  // 2. Scan physical & virtual adapters
  const localList: ServerNetworkInterface[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      // Only include IPv4 for connection simplicity
      const familyStr = String(info.family);
      if (familyStr !== 'IPv4' && familyStr !== '4') continue;

      const classification = classifyInterface(name, info.address, info.internal);
      localList.push({
        name,
        address: info.address,
        family: 'IPv4',
        type: classification.type,
        description: classification.description,
      });
    }
  }

  // 3. Sort: VPN first (most common for home game servers), then LAN, then Loopback
  localList.sort((a, b) => {
    const order = { vpn: 1, lan: 2, loopback: 3, public: 4 };
    return (order[a.type] || 5) - (order[b.type] || 5);
  });

  result.push(...localList);
  return result;
}
