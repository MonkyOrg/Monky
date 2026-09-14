import crypto from 'crypto';
import dgram from 'dgram';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { IceServerConfig, LIMITS, TurnAvailability, TurnInstallProgressPayload, TurnInstallStage, TurnUnavailableReason } from '@monky/shared';
import { Logger } from '../logger/Logger';
import { getPublicIp } from '../discovery/ServerIpScanner';

/** Default STUN servers, used whether or not the relay is on (#425). */
export const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export const TURN_LISTENING_PORT = LIMITS.TURN_LISTENING_PORT;
export const TURN_RELAY_MIN_PORT = LIMITS.TURN_RELAY_MIN_PORT;
export const TURN_RELAY_MAX_PORT = LIMITS.TURN_RELAY_MAX_PORT;

/** How long credentials handed to a client stay valid. */
const CREDENTIAL_TTL_SECONDS = 12 * 60 * 60;

/** Package installs cross the network and can be slow on a cold VPS. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const SERVICE_TIMEOUT_MS = 15 * 1000;

export type TurnInstallFailure =
  | 'unsupported-platform'
  | 'no-privileges'
  | 'unknown-package-manager'
  | 'install-failed';

export type TurnInstallOutcome =
  | { ok: true; alreadyInstalled: boolean }
  | { ok: false; reason: TurnInstallFailure; detail?: string };

/** Notified after each step of an automatic installation (#438). */
export type TurnInstallProgressListener = (progress: TurnInstallProgressPayload) => void;

export type TurnPortProblem =
  | { code: 'not-listening'; port: number }
  | { code: 'external-unreachable'; port: number; publicIp: string; minPort: number; maxPort: number }
  | { code: 'relay-bind-failed'; port: number; minPort: number; maxPort: number };

/**
 * Runs a coturn TURN server next to the Monky server (#425).
 *
 * ## Why a relay is needed at all
 *
 * Two members behind CGNAT (carrier-grade NAT) usually cannot reach each other
 * directly. STUN only *reports* a peer's public address; when both sides sit
 * behind a symmetric NAT the mapped port changes per destination, so the
 * address one side learns is useless to the other. A TURN server sits in the
 * middle and forwards the media, which is the only reliable fix for such a
 * pair.
 *
 * ICE always prefers a direct path and falls back to the relay on its own, so
 * enabling this costs the host bandwidth only for the pairs that truly need it.
 *
 * ## Why coturn is not bundled
 *
 * coturn publishes no official binaries — its releases carry source and Docker
 * images only. Rather than ship an unvetted build, it is installed from the
 * host's own distribution, which also means security updates arrive through the
 * distro. The server does that installation itself when the relay is switched
 * on (#431); `scripts/install-turn.sh` remains for operators who would rather
 * do it by hand, or whose server runs without the privileges to do it. That is
 * why this is Linux-only for now: no coturn package exists for Windows or
 * macOS.
 */
export class CoturnManager {
  private process: ChildProcess | null = null;
  private configPath: string;
  /** Set while `stop()` is tearing down, so the exit handler stays quiet. */
  private stopping = false;
  /** Shared so concurrent requests never run two package managers at once. */
  private static installInFlight: Promise<TurnInstallOutcome> | null = null;
  /**
   * Everyone waiting on the current installation (#438).
   *
   * A set rather than a single callback because the install promise is shared:
   * a second operator who flips the switch mid-install joins the running job,
   * and would otherwise stare at a modal with no progress at all.
   */
  private static installListeners = new Set<TurnInstallProgressListener>();

  constructor(private dataDir: string) {
    this.configPath = path.join(this.dataDir, 'turnserver.conf');
  }

  /**
   * Whether this host can run the relay at all.
   *
   * Kept separate from `isInstalled()` so the UI can tell "your platform is not
   * supported" apart from "install it and you are good to go".
   */
  public static isSupportedPlatform(): boolean {
    return os.platform() === 'linux';
  }

  /** Absolute path of the coturn binary, or null when it is not installed. */
  public static findBinary(): string | null {
    if (!CoturnManager.isSupportedPlatform()) return null;
    try {
      const result = spawnSync('which', ['turnserver'], { encoding: 'utf8' });
      const found = (result.stdout || '').trim().split('\n')[0]?.trim();
      return found ? found : null;
    } catch {
      return null;
    }
  }

  public static isInstalled(): boolean {
    return CoturnManager.findBinary() !== null;
  }

  /**
   * Why the relay cannot run here, as a code, or null when it can.
   *
   * A code rather than a sentence because this crosses the wire to clients that
   * may be running in another language (#429). The CLI, which is always read by
   * whoever administers the host, keeps the prose version below.
   */
  public static getUnavailability(): TurnUnavailableReason | null {
    if (!CoturnManager.isSupportedPlatform()) return 'unsupported-platform';
    if (!CoturnManager.isInstalled()) return 'not-installed';
    return null;
  }

  /** Availability as reported to clients, so the UI can disable the toggle. */
  public static describeAvailability(): TurnAvailability {
    const reason = CoturnManager.getUnavailability();
    if (!reason) return { supported: true };
    // A missing coturn is not a dead end when the host lets us install it: the
    // toggle stays usable and the server does the work (#431).
    if (reason === 'not-installed') {
      return { supported: false, reason, autoInstallable: CoturnManager.detectElevation() !== null };
    }
    return { supported: false, reason };
  }

  /**
   * How the server can run a privileged command, or null when it cannot.
   *
   * `sudo -n` never prompts: it either works without a password or fails right
   * away. Prompting would hang a background install forever with nobody at the
   * terminal to answer (#431).
   */
  private static detectElevation(): 'root' | 'sudo' | null {
    if (!CoturnManager.isSupportedPlatform()) return null;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return 'root';
    try {
      const probe = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8', timeout: 5000 });
      return probe.status === 0 ? 'sudo' : null;
    } catch {
      return null;
    }
  }

  /**
   * Explains why the relay cannot start here, or null when it can.
   *
   * Returning the reason rather than a bare boolean lets both the CLI and the
   * desktop client show the operator something actionable.
   */
  public static getUnavailabilityReason(): string | null {
    switch (CoturnManager.getUnavailability()) {
      case 'unsupported-platform':
        return 'O relay TURN só é suportado em servidores Linux. Não existe pacote do coturn para Windows ou macOS.';
      case 'not-installed':
        return CoturnManager.detectElevation() === null
          ? 'O coturn não está instalado e o servidor não tem privilégio para instalá-lo. Rode "sudo bash scripts/install-turn.sh" no host.'
          : 'O coturn não está instalado.';
      default:
        return null;
    }
  }

  /**
   * Installs coturn from the distribution's repository when it is missing.
   *
   * Turning the relay on is the whole intent; making somebody open a terminal
   * to finish the job is friction the server can absorb itself (#431).
   *
   * The in-flight promise is shared so two operators flipping the switch at the
   * same time do not launch two package managers — the second would die on the
   * apt/dnf lock and report a confusing failure.
   */
  public static ensureInstalled(onProgress?: TurnInstallProgressListener): Promise<TurnInstallOutcome> {
    if (onProgress) CoturnManager.installListeners.add(onProgress);
    if (CoturnManager.installInFlight) return CoturnManager.installInFlight;
    const run = CoturnManager.runInstall().finally(() => {
      CoturnManager.installInFlight = null;
      CoturnManager.installListeners.clear();
    });
    CoturnManager.installInFlight = run;
    return run;
  }

  /** A listener that throws must not take the installation down with it. */
  private static emitProgress(completed: number, total: number, stage: TurnInstallStage): void {
    const payload: TurnInstallProgressPayload = {
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : 100,
      stage,
    };
    for (const listener of CoturnManager.installListeners) {
      try {
        listener(payload);
      } catch (error) {
        Logger.warn('NETWORK', `A TURN install progress listener failed: ${String(error)}`);
      }
    }
  }

  private static async runInstall(): Promise<TurnInstallOutcome> {
    if (!CoturnManager.isSupportedPlatform()) {
      return { ok: false, reason: 'unsupported-platform' };
    }
    if (CoturnManager.isInstalled()) {
      return { ok: true, alreadyInstalled: true };
    }

    const elevation = CoturnManager.detectElevation();
    if (!elevation) return { ok: false, reason: 'no-privileges' };

    const steps = CoturnManager.buildInstallSteps();
    if (!steps) return { ok: false, reason: 'unknown-package-manager' };

    // The package steps plus the service stand-down, which is the last thing
    // between the install and a usable relay.
    const total = steps.length + 1;

    Logger.info('NETWORK', 'Installing coturn so the TURN relay can start...');
    for (const [index, step] of steps.entries()) {
      CoturnManager.emitProgress(index, total, step.stage);
      const result = await CoturnManager.runPrivileged(elevation, step.command, INSTALL_TIMEOUT_MS);
      if (!result.ok) {
        Logger.error('NETWORK', `coturn installation failed at "${step.command.join(' ')}": ${result.detail}`);
        return { ok: false, reason: 'install-failed', detail: result.detail };
      }
    }

    if (!CoturnManager.isInstalled()) {
      return { ok: false, reason: 'install-failed', detail: 'turnserver não apareceu no PATH após a instalação.' };
    }

    CoturnManager.emitProgress(steps.length, total, 'configuring');
    await CoturnManager.standDownSystemService(elevation);
    CoturnManager.emitProgress(total, total, 'configuring');
    Logger.info('NETWORK', 'coturn installed successfully.');
    return { ok: true, alreadyInstalled: false };
  }

  /**
   * Package manager commands for the distributions coturn ships on, each
   * labelled with the stage it represents so the client can say what is
   * happening instead of only how much is left (#438).
   */
  private static buildInstallSteps(): { stage: TurnInstallStage; command: string[] }[] | null {
    if (CoturnManager.hasCommand('apt-get')) {
      return [
        { stage: 'refreshing', command: ['apt-get', 'update'] },
        { stage: 'installing', command: ['apt-get', 'install', '-y', 'coturn'] },
      ];
    }
    if (CoturnManager.hasCommand('dnf')) return [{ stage: 'installing', command: ['dnf', 'install', '-y', 'coturn'] }];
    if (CoturnManager.hasCommand('yum')) return [{ stage: 'installing', command: ['yum', 'install', '-y', 'coturn'] }];
    if (CoturnManager.hasCommand('pacman')) {
      return [{ stage: 'installing', command: ['pacman', '-Sy', '--noconfirm', 'coturn'] }];
    }
    if (CoturnManager.hasCommand('zypper')) {
      return [{ stage: 'installing', command: ['zypper', '--non-interactive', 'install', 'coturn'] }];
    }
    if (CoturnManager.hasCommand('apk')) return [{ stage: 'installing', command: ['apk', 'add', '--no-cache', 'coturn'] }];
    return null;
  }

  private static hasCommand(command: string): boolean {
    try {
      return spawnSync('which', [command], { encoding: 'utf8', timeout: 5000 }).status === 0;
    } catch {
      return false;
    }
  }

  /**
   * The distribution ships coturn as a system service that grabs port 3478 on
   * boot. Monky spawns and configures its own process, so the packaged service
   * has to stand down or the two fight over the port.
   */
  private static async standDownSystemService(elevation: 'root' | 'sudo'): Promise<void> {
    if (!CoturnManager.hasCommand('systemctl')) return;
    // Best effort throughout: a host without this unit is perfectly fine, and
    // failing here would waste an installation that actually worked.
    await CoturnManager.runPrivileged(elevation, ['systemctl', 'stop', 'coturn'], SERVICE_TIMEOUT_MS);
    await CoturnManager.runPrivileged(elevation, ['systemctl', 'disable', 'coturn'], SERVICE_TIMEOUT_MS);
  }

  /** Runs a command as root, without ever waiting on a password prompt. */
  private static runPrivileged(
    elevation: 'root' | 'sudo',
    command: string[],
    timeoutMs: number
  ): Promise<{ ok: boolean; detail: string }> {
    const [bin, ...args] = elevation === 'sudo' ? ['sudo', '-n', ...command] : command;

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          // Keeps apt from stopping to ask questions nobody is there to answer.
          env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
        });
      } catch (error) {
        resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
        return;
      }

      let stderr = '';
      let settled = false;
      const finish = (ok: boolean, detail: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, detail });
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(false, `O comando "${command.join(' ')}" excedeu o tempo limite.`);
      }, timeoutMs);

      child.stderr?.on('data', (chunk: Buffer) => {
        // Only the tail matters: package managers are chatty and the useful
        // line is the last one.
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.on('error', (error) => finish(false, error.message));
      child.on('close', (code) => {
        if (code === 0) finish(true, '');
        else finish(false, stderr.trim() || `saiu com código ${code}`);
      });
    });
  }

  public isRunning(): boolean {
    return this.process !== null;
  }

  /**
   * Starts coturn with a generated configuration.
   *
   * A coturn that dies immediately (a busy port, say) is reported through the
   * logs and leaves the relay off, because the server must keep running either
   * way: losing the relay degrades calls for CGNAT users, but taking the whole
   * server down would break them for everyone.
   */
  public async start(secret: string): Promise<boolean> {
    if (this.process) return true;

    const binary = CoturnManager.findBinary();
    if (!binary) {
      Logger.warn('NETWORK', `TURN relay not started: ${CoturnManager.getUnavailabilityReason()}`);
      return false;
    }

    // Detect the public IP so coturn can advertise the correct relay address.
    // On most VPS providers the VM has a private NIC with the public IP mapped
    // via NAT; without external-ip coturn would report the private address and
    // relay candidates would be unreachable.
    let externalIp: string | null = null;
    try {
      externalIp = await getPublicIp();
      if (externalIp) {
        Logger.info('NETWORK', `Detected public IP for TURN relay: ${externalIp}`);
      } else {
        Logger.warn('NETWORK', 'Could not detect public IP — coturn will try to guess it. Relay may fail on NAT-based VPS.');
      }
    } catch {
      Logger.warn('NETWORK', 'Public IP detection failed — coturn will try to guess it.');
    }

    // Detect the local/private IP that the VPS NIC uses, so we can tell coturn
    // the mapping between external and internal addresses.
    const localIp = CoturnManager.detectLocalIp();

    try {
      // 0600: the file holds the shared secret behind every credential.
      await fs.promises.writeFile(this.configPath, this.buildConfig(secret, externalIp, localIp), { mode: 0o600 });
    } catch (error) {
      Logger.error('NETWORK', 'Failed to write the coturn configuration', error);
      return false;
    }

    try {
      this.stopping = false;
      const child = spawn(binary, ['-c', this.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.process = child;

      child.stdout?.on('data', (chunk: Buffer) => {
        const line = chunk.toString('utf8').trim();
        if (line) Logger.info('NETWORK', `[coturn] ${line}`);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString('utf8').trim();
        if (line) Logger.warn('NETWORK', `[coturn] ${line}`);
      });

      child.on('error', (error) => {
        Logger.error('NETWORK', 'coturn failed to run', error);
        this.process = null;
      });

      child.on('exit', (code, signal) => {
        this.process = null;
        if (this.stopping) return;
        Logger.warn(
          'NETWORK',
          `coturn exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'}). ` +
            'Calls keep working, but members behind CGNAT may fail to connect to each other.'
        );
      });

      // Give coturn a moment to bind, then verify it is actually listening.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (this.process) {
        const reachable = await CoturnManager.probePort(TURN_LISTENING_PORT, 3000);
        if (reachable) {
          Logger.info('NETWORK', `TURN relay started and listening on port ${TURN_LISTENING_PORT} (coturn: ${binary})`);
        } else {
          Logger.warn(
            'NETWORK',
            `coturn was spawned but port ${TURN_LISTENING_PORT} does not appear to be listening. ` +
              'Check the coturn log above for errors, and make sure no other process is using the port.'
          );
        }
      }

      return true;
    } catch (error) {
      Logger.error('NETWORK', 'Failed to start the TURN relay', error);
      this.process = null;
      return false;
    }
  }

  /** Stops coturn, escalating to SIGKILL if it ignores the polite request. */
  public async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;

    this.stopping = true;
    this.process = null;

    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 5000);
      force.unref?.();

      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(force);
        resolve();
      }
    });

    Logger.info('NETWORK', 'TURN relay stopped');
  }

  /**
   * Builds the ICE server list for one client.
   *
   * `host` is the address the client used to reach us, taken from its own
   * connection: the server would otherwise have to guess its public address,
   * which goes wrong behind reverse proxies, on multi-homed hosts and on LAN.
   * Whatever got the client this far is by definition reachable from it.
   */
  public buildIceServers(userId: string, host: string | null, secret: string | null): IceServerConfig[] {
    const iceServers: IceServerConfig[] = [{ urls: [...DEFAULT_STUN_URLS] }];

    if (!this.isRunning() || !host || !secret) return iceServers;

    const { username, credential } = CoturnManager.createCredentials(userId, secret);
    iceServers.push({
      urls: [
        `turn:${host}:${TURN_LISTENING_PORT}?transport=udp`,
        `turn:${host}:${TURN_LISTENING_PORT}?transport=tcp`,
      ],
      username,
      credential,
    });

    return iceServers;
  }

  /**
   * Time-limited credentials per the TURN REST API
   * (draft-uberti-behave-turn-rest-00), which coturn implements as
   * `use-auth-secret`: the username carries the expiry and the password is an
   * HMAC of it. coturn validates them without storing anything, so no account
   * ever has to be created on the relay.
   */
  public static createCredentials(userId: string, secret: string): { username: string; credential: string } {
    const expiry = Math.floor(Date.now() / 1000) + CREDENTIAL_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    return { username, credential };
  }

  /** A fresh shared secret, generated the first time the relay is switched on. */
  public static generateSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private buildConfig(secret: string, externalIp: string | null, localIp: string | null): string {
    const lines = [
      '# Generated by Monky Server. Do not edit: it is rewritten on every start.',
      `listening-port=${TURN_LISTENING_PORT}`,
      'fingerprint',
      // REST-API auth: credentials derive from this secret and expire on their
      // own, so there are no accounts to manage or leak.
      'use-auth-secret',
      `static-auth-secret=${secret}`,
      'realm=monky',
      `min-port=${TURN_RELAY_MIN_PORT}`,
      `max-port=${TURN_RELAY_MAX_PORT}`,
    ];

    // external-ip tells coturn what address to put in relay candidates. Without
    // it a NAT-based VPS (AWS, Oracle, most cloud providers) would advertise
    // its private NIC address, making relay candidates unreachable from clients.
    if (externalIp) {
      if (localIp && localIp !== externalIp) {
        // The mapping form tells coturn "advertise externalIp but bind on localIp".
        lines.push(`external-ip=${externalIp}/${localIp}`);
      } else {
        lines.push(`external-ip=${externalIp}`);
      }
    }

    lines.push(
      // Refuse to relay towards private ranges and loopback. Without this an
      // open relay can be pointed at services on the host's own network, which
      // is the classic way a misconfigured TURN server becomes an attack proxy.
      'no-multicast-peers',
      'denied-peer-ip=0.0.0.0-0.255.255.255',
      'denied-peer-ip=10.0.0.0-10.255.255.255',
      'denied-peer-ip=127.0.0.0-127.255.255.255',
      'denied-peer-ip=169.254.0.0-169.254.255.255',
      'denied-peer-ip=172.16.0.0-172.31.255.255',
      'denied-peer-ip=192.168.0.0-192.168.255.255',
      'denied-peer-ip=::1',
      'denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      // Media is already encrypted end-to-end by DTLS-SRTP, and a TLS listener
      // would need a certificate the operator does not necessarily have.
      'no-tls',
      'no-dtls',
      // The admin console is another listening port we have no use for.
      'no-cli',
      'log-file=stdout',
      'simple-log',
      '',
    );

    return lines.join('\n');
  }

  // ────────────────────────────────────────────
  //  Network helpers
  // ────────────────────────────────────────────

  /**
   * Returns the first non-loopback IPv4 address from the server's interfaces.
   *
   * On a NAT-based VPS (AWS, Oracle, Hetzner cloud) this is the private
   * address the NIC actually holds, while the public one is mapped by the
   * provider. coturn's `external-ip` directive needs the mapping between the
   * two so it can bind locally while advertising the public address to clients.
   */
  private static detectLocalIp(): string | null {
    const interfaces = os.networkInterfaces();
    for (const addrs of Object.values(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
    return null;
  }

  /**
   * Quick TCP probe to check whether something is listening on a local port.
   *
   * Used after spawning coturn to verify it actually bound: a busy port, a bad
   * config line or a missing library makes it exit immediately, and the only
   * sign is a silent absence of relay candidates hours later.
   */
  private static probePort(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const cleanup = () => {
        try { socket.destroy(); } catch { /* already gone */ }
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => { cleanup(); resolve(true); });
      socket.once('timeout', () => { cleanup(); resolve(false); });
      socket.once('error', () => { cleanup(); resolve(false); });
      socket.connect(port, '127.0.0.1');
    });
  }

  /**
   * Verifies that the TURN port is reachable from the outside by asking an
   * external service to probe it, or — when no such service is available —
   * at least confirms it is listening locally.
   *
   * Returns a human-readable reason when the check fails, or null when
   * everything looks good. The CLI can format structured failures in its own
   * language; callers without a formatter keep the existing server messages.
   */
  public static async checkPortReachability(describeProblem?: (problem: TurnPortProblem) => string): Promise<string | null> {
    // First: is anything listening on the TURN port locally?
    const localOk = await CoturnManager.probePort(TURN_LISTENING_PORT, 2000);
    if (!localOk) {
      if (describeProblem) return describeProblem({ code: 'not-listening', port: TURN_LISTENING_PORT });
      return (
        `A porta ${TURN_LISTENING_PORT} não está escutando localmente. ` +
        'Verifique se nenhum outro processo está usando essa porta.'
      );
    }

    // If we can detect a public IP, try to verify external reachability.
    const publicIp = await getPublicIp();
    if (publicIp) {
      const externalOk = await CoturnManager.probePort3478External(publicIp);
      if (!externalOk) {
        if (describeProblem) return describeProblem({
          code: 'external-unreachable', port: TURN_LISTENING_PORT, publicIp,
          minPort: TURN_RELAY_MIN_PORT, maxPort: TURN_RELAY_MAX_PORT,
        });
        return (
          `A porta ${TURN_LISTENING_PORT} (UDP/TCP) não está acessível externamente no IP ${publicIp}. ` +
          `Abra a porta ${TURN_LISTENING_PORT} (UDP e TCP) e o range ${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT} (UDP) ` +
          'no firewall da VPS para que o relay TURN funcione.'
        );
      }
    }

    // Verify the UDP relay range is usable. coturn needs to bind ephemeral
    // ports in this range for actual media relay. We probe a few ports spread
    // across the range to catch firewall rules or exhaustion.
    const relayProbe = await CoturnManager.probeRelayRange(describeProblem);
    if (relayProbe) {
      return relayProbe;
    }

    return null;
  }

  /**
   * Checks that the UDP relay port range is usable by attempting to bind a
   * UDP socket on several sample ports across the range. If any bind fails,
   * it likely means a firewall rule or another process is blocking the range.
   */
  private static async probeRelayRange(describeProblem?: (problem: TurnPortProblem) => string): Promise<string | null> {
    // Test a few ports spread across the range
    const samplePorts = [
      TURN_RELAY_MIN_PORT,
      TURN_RELAY_MIN_PORT + 1000,
      TURN_RELAY_MIN_PORT + 5000,
      TURN_RELAY_MAX_PORT - 1000,
    ];

    for (const port of samplePorts) {
      const bindOk = await CoturnManager.probeUdpBind(port, 2000);
      if (!bindOk) {
        if (describeProblem) return describeProblem({
          code: 'relay-bind-failed', port, minPort: TURN_RELAY_MIN_PORT, maxPort: TURN_RELAY_MAX_PORT,
        });
        return (
          `O range de portas UDP ${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT} não está acessível ` +
          `(falha ao testar porta ${port}/UDP). ` +
          `Abra o range ${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT} (UDP) no firewall da VPS. ` +
          'Sem essas portas, o relay TURN não consegue transmitir mídia.'
        );
      }
    }

    return null;
  }

  /**
   * Tries to bind a UDP socket on the given port. Returns true if the bind
   * succeeds (port is available), false otherwise. The socket is immediately
   * closed after the test.
   */
  private static probeUdpBind(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* already closed */ }
        resolve(false);
      }, timeoutMs);

      socket.once('error', () => {
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closed */ }
        resolve(false);
      });

      socket.bind(port, '0.0.0.0', () => {
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closed */ }
        resolve(true);
      });
    });
  }

  /**
   * Tries a TCP connection to our own public IP on the TURN port.
   *
   * This is not a perfect external probe (a hairpin NAT or firewall rule could
   * make it pass while real clients still fail), but it catches the very common
   * case of a default-deny VPS firewall — which is exactly what happened in the
   * field (#425).
   */
  private static probePort3478External(publicIp: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const cleanup = () => {
        try { socket.destroy(); } catch { /* already gone */ }
      };

      socket.setTimeout(4000);
      socket.once('connect', () => { cleanup(); resolve(true); });
      socket.once('timeout', () => { cleanup(); resolve(false); });
      socket.once('error', () => { cleanup(); resolve(false); });
      socket.connect(TURN_LISTENING_PORT, publicIp);
    });
  }
}
