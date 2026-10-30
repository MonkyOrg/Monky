import type http from 'http';
import { Logger } from '../logger/Logger';

export interface HttpRequestTarget {
  /** Path without the query string, still percent-encoded. */
  readonly pathname: string;
  readonly query: URLSearchParams;
}

export type HttpRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: HttpRequestTarget,
) => void | Promise<void>;

export interface HttpRoute {
  readonly methods: readonly string[];
  /** Exact path, or — when it ends in '/' — every path under it. */
  readonly path: string;
  readonly handle: HttpRouteHandler;
}

export const GET_OR_HEAD: readonly string[] = ['GET', 'HEAD'];

const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
  'Access-Control-Max-Age': '86400',
};

/** Ends the response with a bare status, unless an answer already went out. */
export function sendStatus(res: http.ServerResponse, status: number): void {
  if (res.headersSent) return;
  res.writeHead(status);
  res.end();
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * One table of routes for the HTTP side of the server (S-WS-11). Paths are
 * compared without the query string, CORS is set in a single place, and a
 * route that throws or rejects answers 500 instead of escaping the listener:
 * an exception there is uncaught, and one anonymous request used to take the
 * whole process down with it (S-WS-1).
 */
export function createHttpRequestListener(routes: readonly HttpRoute[]): http.RequestListener {
  return (req, res) => {
    // Every route is public or authorized by a capability in its URL, and the
    // desktop app reads them cross-origin (it runs from file://).
    res.setHeader('Access-Control-Allow-Origin', '*');
    // With requestTimeout off, so that long uploads are not cut, nothing ends a
    // body that keeps trickling in after an early answer: Node keeps the
    // connection to drain it, and a byte every few seconds holds it forever. A
    // request with a body therefore ends its connection once answered (S-WS-11).
    if (carriesBody(req)) res.setHeader('Connection', 'close');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, PREFLIGHT_HEADERS);
        res.end();
        return;
      }
      const target = parseTarget(req.url);
      const method = req.method ?? '';
      const route = routes.find((candidate) =>
        candidate.methods.includes(method) && matchesPath(candidate.path, target.pathname));
      if (!route) {
        sendStatus(res, 404);
        return;
      }
      const pending = route.handle(req, res, target);
      if (pending) pending.catch((error: unknown) => fail(res, error));
    } catch (error) {
      fail(res, error);
    }
  };
}

function parseTarget(url: string | undefined): HttpRequestTarget {
  const raw = url ?? '/';
  const queryStart = raw.indexOf('?');
  return queryStart === -1
    ? { pathname: raw, query: new URLSearchParams() }
    : { pathname: raw.slice(0, queryStart), query: new URLSearchParams(raw.slice(queryStart + 1)) };
}

function matchesPath(routePath: string, pathname: string): boolean {
  return routePath.endsWith('/') ? pathname.startsWith(routePath) : pathname === routePath;
}

/** Whether the request announces a body. Node answers 400 to a malformed length before any route runs. */
function carriesBody(req: http.IncomingMessage): boolean {
  return req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
}

function fail(res: http.ServerResponse, error: unknown): void {
  Logger.error('NETWORK', 'An HTTP request failed.', error);
  if (!res.headersSent) sendStatus(res, 500);
  else if (!res.writableEnded) res.destroy();
}
