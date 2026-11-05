import type http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

/** First byte of every TLS connection: a handshake record. No HTTP method starts with it. */
const TLS_HANDSHAKE_RECORD = 0x16;

/**
 * One port, two protocols (#860): connections that open with a TLS handshake
 * are decrypted with the current certificate, everything else is plain HTTP.
 * Both reach the same `http.Server`, so routes and the WebSocket upgrade are
 * shared, `ws://` keeps working for older clients and for whoever reaches the
 * server through a VPN, and an invitation only gains `tls: true`.
 *
 * Swapping the certificate affects new connections only: the ones already
 * open keep the session they negotiated.
 */
export class DualProtocolListener {
  /** A connection that never says anything is dropped before HTTP's own deadlines apply. */
  static FIRST_BYTE_TIMEOUT_MS = 10_000;

  private readonly server: net.Server;
  private readonly pending = new Set<net.Socket>();
  private context: tls.SecureContext | null = null;

  constructor(private readonly httpServer: http.Server) {
    this.server = net.createServer((socket) => this.accept(socket));
    // The listener used to be the HTTP server itself: its errors keep reaching whoever watches that one.
    this.server.on('error', (error) => httpServer.emit('error', error));
  }

  /** `null` turns TLS off: handshakes are refused and plain connections continue. */
  public setSecureContext(context: tls.SecureContext | null): void {
    this.context = context;
  }

  public get secure(): boolean {
    return this.context !== null;
  }

  public get listener(): net.Server {
    return this.server;
  }

  public address(): ReturnType<net.Server['address']> {
    return this.server.address();
  }

  /** Stops accepting and drops connections that never sent a byte; open HTTP ones belong to `httpServer`. */
  public close(): Promise<void> {
    for (const socket of this.pending) socket.destroy();
    this.pending.clear();
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error);
        else resolve();
      });
    });
  }

  private accept(socket: net.Socket): void {
    this.pending.add(socket);
    const settle = (): void => {
      this.pending.delete(socket);
      socket.setTimeout(0);
      socket.off('timeout', drop);
      socket.off('error', drop);
      socket.off('close', settle);
      socket.off('data', dispatch);
    };
    const drop = (): void => { settle(); socket.destroy(); };
    const dispatch = (chunk: Buffer): void => {
      settle();
      socket.pause();
      socket.unshift(chunk);
      if (chunk[0] !== TLS_HANDSHAKE_RECORD) {
        this.httpServer.emit('connection', socket);
        socket.resume();
        return;
      }
      const context = this.context;
      if (!context) {
        socket.destroy();
        return;
      }
      // The TLS layer takes the bytes already read, the ClientHello included, from the socket's buffer.
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'] });
      this.httpServer.emit('connection', secure);
    };
    socket.setTimeout(DualProtocolListener.FIRST_BYTE_TIMEOUT_MS);
    socket.once('timeout', drop);
    socket.once('error', drop);
    socket.once('close', settle);
    socket.once('data', dispatch);
  }
}
