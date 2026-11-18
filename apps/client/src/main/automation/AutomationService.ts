import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AUTOMATION_TOOLS, AutomationError, automationCommandSchema, automationMutationSchema,
  type AutomationCommand, type AutomationConnection, type AutomationGrant, type AutomationMutationResult,
  type AutomationResult, type AutomationSnapshot, type AutomationErrorCode,
} from '@monky/shared';
import { AutomationStore } from './AutomationStore';

export type AutomationExecutor = (command: AutomationCommand, grant: AutomationGrant, signal: AbortSignal) => Promise<AutomationResult>;

function objectSchema(schema: z.ZodType<unknown>): { type: 'object'; [key: string]: unknown } {
  const json: object = zodToJsonSchema<'jsonSchema7'>(schema, { $refStrategy: 'none' });
  return { ...json, type: 'object' };
}

export class AutomationService {
  private server: Server | null = null;
  private error: AutomationErrorCode | null = null;
  private readonly pending = new Map<AbortController, string>();
  private readonly requests = new Map<string, AbortController>();
  private lifecycle: Promise<void> = Promise.resolve();
  private closed = false;
  private generation = 0;

  constructor(readonly store: AutomationStore, private readonly execute: AutomationExecutor,
    private readonly changed: (snapshot: AutomationSnapshot) => void = () => {}) {}

  snapshot(): AutomationSnapshot {
    const address = this.server?.address();
    return { ...this.store.snapshot(), url: address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}/mcp` : null, error: this.error ?? this.store.loadError };
  }

  start(): Promise<void> { return this.schedule(() => this.listen()); }

  mutate(value: unknown): Promise<AutomationMutationResult> {
    let result: AutomationMutationResult = { snapshot: this.snapshot() };
    const operation = this.schedule(async () => {
      try {
        if (this.closed) throw new AutomationError('not_ready');
        const input = automationMutationSchema.parse(value);
        this.generation++;
        // Revoke running work before publishing a narrower grant or rotating its token.
        const id = 'id' in input ? input.id : input.action === 'save' ? input.connection.id : undefined;
        this.cancel(id);
        const credential = this.store.mutate(input);
        if (input.action === 'enable' || input.action === 'change_port') {
          await this.stop();
          await this.listen();
        }
        result = { snapshot: this.snapshot(), ...(credential.id && credential.token ? { credential: { id: credential.id, token: credential.token } } : {}) };
      } catch (error) {
        result = { snapshot: this.snapshot(), error: error instanceof AutomationError ? error.code : 'invalid_input' };
      }
      this.changed(this.snapshot());
    });
    return operation.then(() => result);
  }

  private schedule(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  private async listen(): Promise<void> {
    this.error = null;
    if (this.closed || !this.store.enabled || this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end();
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.store.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new AutomationError('port_unavailable');
      this.store.setPort(address.port);
      this.server = server;
      server.on('error', () => { this.error = 'port_unavailable'; this.changed(this.snapshot()); });
    } catch (error) {
      server.close();
      this.error = error instanceof AutomationError ? error.code : 'port_unavailable';
    }
    this.changed(this.snapshot());
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = this.snapshot().url;
    if (!url || this.closed || !this.store.enabled) { response.writeHead(503).end(); return; }
    const host = new URL(url).host;
    const origin = request.headers.origin;
    if (request.headers.host !== host || (origin !== undefined && origin !== `http://${host}`)) {
      response.writeHead(403).end(); return;
    }
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const connection = token.length <= 128 ? this.store.authenticate(token) : undefined;
    if (!connection) { response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="Monky"' }).end(); return; }
    const generation = this.generation;

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > 65_536) { response.writeHead(413).end(); return; }
      chunks.push(buffer);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const cancellation = CancelledNotificationSchema.safeParse(body);
    if (cancellation.success) {
      this.requests.get(JSON.stringify([connection.id, cancellation.data.params.requestId]))?.abort();
      response.writeHead(202).end();
      return;
    }
    const requestKey = isJSONRPCRequest(body) ? JSON.stringify([connection.id, body.id]) : null;
    if (requestKey && this.requests.has(requestKey)) { response.writeHead(409).end(); return; }
    const disconnected = new AbortController();
    if (requestKey) this.requests.set(requestKey, disconnected);
    // Each HTTP request owns its transport; grants are never cached in an MCP session.
    const mcp = new McpServer({ name: 'monky', version: '1.0.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(AUTOMATION_TOOLS)
      .filter(([, tool]) => connection.capabilities.includes(tool.capability))
      .map(([name, tool]) => ({
        name, description: tool.description, inputSchema: objectSchema(tool.input), outputSchema: objectSchema(tool.output),
        annotations: { readOnlyHint: tool.capability === 'read' },
      })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const parsed = automationCommandSchema.safeParse({ tool: request.params.name, args: request.params.arguments ?? {} });
      const result: AutomationResult = parsed.success
        ? await this.run(connection, parsed.data, AbortSignal.any([extra.signal, disconnected.signal]), generation) : { ok: false, code: 'invalid_input' };
      return { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result) }], ...(result.ok ? { structuredContent: result.data } : {}) };
    });
    response.once('close', () => {
      disconnected.abort();
      if (requestKey) this.requests.delete(requestKey);
      void mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  async run(connection: AutomationConnection, command: AutomationCommand, signal: AbortSignal, generation = this.generation): Promise<AutomationResult> {
    const current = this.store.get(connection.id);
    if (this.closed || generation !== this.generation || !this.store.enabled || !current || JSON.stringify(current) !== JSON.stringify(connection)
      || !current.capabilities.includes(AUTOMATION_TOOLS[command.tool].capability)) return { ok: false, code: 'not_authorized' };
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    this.pending.set(controller, connection.id);
    let result: AutomationResult;
    try {
      if (controller.signal.aborted) throw new AutomationError('cancelled');
      const { serverIds, capabilities } = current;
      result = await this.execute(command, { serverIds, capabilities }, controller.signal);
      if (result.ok) {
        const parsed = AUTOMATION_TOOLS[command.tool].output.safeParse(result.data);
        result = parsed.success ? { ok: true, data: parsed.data } : { ok: false, code: 'failed' };
      }
    } catch (error) {
      result = { ok: false, code: error instanceof AutomationError ? error.code : 'failed' };
    } finally {
      signal.removeEventListener('abort', abort);
      this.pending.delete(controller);
    }
    if (controller.signal.aborted) result = { ok: false,
      code: AUTOMATION_TOOLS[command.tool].capability === 'read' ? 'cancelled' : 'unknown_outcome' };
    try {
      this.store.record({
        connection: connection.name, tool: command.tool,
        destination: 'sessionRef' in command.args ? command.args.sessionRef + ('channelId' in command.args ? `/${command.args.channelId}` : '') : '',
        timestamp: Date.now(),
        result: result.ok ? 'completed' : result.code === 'unknown_outcome' ? 'unknown' : 'rejected',
      });
    } catch { this.error = 'storage_failed'; }
    this.changed(this.snapshot());
    return result;
  }

  private cancel(id?: string): void {
    for (const [controller, owner] of this.pending) if (!id || owner === id) controller.abort();
  }

  private async stop(): Promise<void> {
    this.cancel();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.cancel();
    return this.schedule(() => this.stop());
  }
}
