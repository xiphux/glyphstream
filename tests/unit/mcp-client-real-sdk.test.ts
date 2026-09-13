/**
 * `connectMcpServer` against a REAL MCP server built on the SDK itself — no
 * mocks of `@modelcontextprotocol/sdk`.
 *
 * mcp-client.test.ts mocks all three SDK entry points and the registry tests mock
 * our client, so an SDK minor (auto-merged: it's 1.x) that changed transport
 * behavior or error classes would pass the suite. These pin what we rely on:
 *
 * - list/call round-trips over Streamable HTTP and stdio, with the bearer header
 *   and `isError` surfaced as we map them;
 * - `post_only` never opening the server→client GET stream;
 * - the handshake re-roll on a "Session not found" response (the Fastmail case);
 * - the error CLASSES registry.ts's retry decision keys on: a server-side tool
 *   error must be `McpError` and an HTTP error status `StreamableHTTPError`
 *   (neither may be retried — the call may have run), while a refused
 *   connection must be neither (safe to retry);
 * - a per-call timeout rejecting within the budget;
 * - `onClose` firing when a stdio server exits.
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connectMcpServer, type McpConnection } from '../../src/lib/server/mcp/client';
import type { LoadedHttpMcpServer, LoadedStdioMcpServer } from '../../src/lib/server/mcp/config';

vi.stubGlobal('__APP_VERSION__', 'test');

const TIMEOUT_MS = 5000;

/** A real SDK server: `echo`, `fail` (handler throws), and `slow` (never answers
 *  within the test's timeout). Stateful Streamable HTTP, one session per client. */
function mcpServer(): Server {
	const server = new Server(
		{ name: 'http-fixture', version: '0.0.0' },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [
			{
				name: 'echo',
				description: 'Echo the text back',
				inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
			},
			{ name: 'fail', inputSchema: { type: 'object' } },
			{ name: 'soft_fail', inputSchema: { type: 'object' } },
			{ name: 'slow', inputSchema: { type: 'object' } },
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		switch (req.params.name) {
			case 'echo':
				return { content: [{ type: 'text', text: `http:${String(req.params.arguments?.text)}` }] };
			case 'soft_fail':
				return { content: [{ type: 'text', text: 'nope' }], isError: true };
			case 'fail':
				throw new McpError(ErrorCode.InternalError, 'tool exploded');
			case 'slow':
				await new Promise((r) => setTimeout(r, 30_000));
				return { content: [] };
			default:
				throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${req.params.name}`);
		}
	});
	return server;
}

interface Harness {
	url: string;
	requests: Array<{ method: string; accept: string; authorization: string | undefined }>;
	/** Answer the next N non-initialize POSTs with the given status + body. */
	failNext: (count: number, status: number, body: unknown) => void;
	close: () => Promise<void>;
}

const harnesses: Harness[] = [];
const connections: McpConnection[] = [];

async function startHttpServer(): Promise<Harness> {
	const transports = new Map<string, StreamableHTTPServerTransport>();
	const requests: Harness['requests'] = [];
	let failures: { count: number; status: number; body: unknown } | null = null;

	const readBody = (req: IncomingMessage) =>
		new Promise<unknown>((resolve) => {
			let raw = '';
			req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
			req.on('end', () => resolve(raw ? JSON.parse(raw) : undefined));
		});

	const http: HttpServer = createServer((req, res) => {
		void (async () => {
			requests.push({
				method: req.method ?? '',
				accept: req.headers.accept ?? '',
				authorization: req.headers.authorization,
			});
			const body = req.method === 'POST' ? await readBody(req) : undefined;
			const isInitialize =
				!!body && typeof body === 'object' && (body as { method?: string }).method === 'initialize';

			if (failures && failures.count > 0 && req.method === 'POST' && !isInitialize) {
				failures.count--;
				res.writeHead(failures.status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(failures.body));
				return;
			}

			const sessionId = req.headers['mcp-session-id'] as string | undefined;
			let transport = sessionId ? transports.get(sessionId) : undefined;
			if (!transport && isInitialize) {
				transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (id) => {
						transports.set(id, transport!);
					},
				});
				await mcpServer().connect(transport);
			}
			if (!transport) {
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						error: { code: -32001, message: 'Session not found' },
						id: null,
					}),
				);
				return;
			}
			await transport.handleRequest(req, res, body);
		})();
	});
	await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
	const { port } = http.address() as AddressInfo;

	const harness: Harness = {
		url: `http://127.0.0.1:${port}/mcp`,
		requests,
		failNext: (count, status, body) => (failures = { count, status, body }),
		close: async () => {
			for (const t of transports.values()) await t.close().catch(() => {});
			http.closeAllConnections();
			await new Promise<void>((r) => http.close(() => r()));
		},
	};
	harnesses.push(harness);
	return harness;
}

function httpCfg(url: string, overrides: Partial<LoadedHttpMcpServer> = {}): LoadedHttpMcpServer {
	return {
		id: 'fixture',
		displayName: 'Fixture',
		auth: 'global',
		timeoutSeconds: 5,
		idleTimeoutSeconds: 0,
		deferTools: false,
		transport: 'http',
		url,
		apiKey: null,
		postOnly: false,
		...overrides,
	};
}

async function connect(cfg: LoadedHttpMcpServer | LoadedStdioMcpServer): Promise<McpConnection> {
	const conn = await connectMcpServer(cfg, TIMEOUT_MS);
	connections.push(conn);
	return conn;
}

const signal = () => new AbortController().signal;

afterEach(async () => {
	for (const c of connections.splice(0)) await c.close();
	for (const h of harnesses.splice(0)) await h.close();
});

describe('connectMcpServer over Streamable HTTP (real SDK server)', () => {
	it('lists tools and round-trips a call, sending the bearer token', async () => {
		const h = await startHttpServer();
		const conn = await connect(httpCfg(h.url, { apiKey: 'secret-token' }));

		const tools = await conn.listTools();
		expect(tools.map((t) => t.name)).toEqual(['echo', 'fail', 'soft_fail', 'slow']);
		expect(tools[0]).toEqual({
			name: 'echo',
			description: 'Echo the text back',
			inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
		});
		expect(tools[1].description).toBe('');

		const res = await conn.callTool('echo', { text: 'hi' }, signal(), TIMEOUT_MS);
		expect(res).toEqual({ content: [{ type: 'text', text: 'http:hi' }], isError: false });

		const soft = await conn.callTool('soft_fail', {}, signal(), TIMEOUT_MS);
		expect(soft.isError).toBe(true);

		const posts = h.requests.filter((r) => r.method === 'POST');
		expect(posts.length).toBeGreaterThan(0);
		expect(posts.every((r) => r.authorization === 'Bearer secret-token')).toBe(true);
	});

	it('post_only never opens the server→client GET event stream', async () => {
		// Contrast first, so "no GET" below means something: by default the SDK
		// does open the stream after the handshake.
		const plain = await startHttpServer();
		await connect(httpCfg(plain.url));
		await expect
			.poll(() =>
				plain.requests.some((r) => r.method === 'GET' && r.accept.includes('text/event-stream')),
			)
			.toBe(true);

		const h = await startHttpServer();
		const conn = await connect(httpCfg(h.url, { postOnly: true }));

		await conn.listTools();
		await conn.callTool('echo', { text: 'x' }, signal(), TIMEOUT_MS);

		expect(h.requests.filter((r) => r.method === 'GET')).toEqual([]);
	});

	it('re-rolls the handshake once on "Session not found"', async () => {
		const h = await startHttpServer();
		// The first post-initialize POST of the first attempt (the
		// notifications/initialized message) is rejected the way Fastmail's
		// load balancer does; the second attempt connects cleanly.
		h.failNext(1, 404, {
			jsonrpc: '2.0',
			error: { code: -32600, message: 'Invalid Request: Session not found' },
			id: null,
		});

		const conn = await connect(httpCfg(h.url));

		expect(h.requests.filter((r) => r.method === 'POST').length).toBeGreaterThanOrEqual(3);
		expect((await conn.listTools()).length).toBe(4);
	});

	it('a server-side tool error is an McpError (registry must not retry it)', async () => {
		const h = await startHttpServer();
		const conn = await connect(httpCfg(h.url));

		const err = await conn.callTool('fail', {}, signal(), TIMEOUT_MS).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(McpError);
		expect((err as McpError).message).toContain('tool exploded');
	});

	it('an HTTP error status is a StreamableHTTPError (registry must not retry it)', async () => {
		const h = await startHttpServer();
		const conn = await connect(httpCfg(h.url));
		h.failNext(1, 500, { error: 'boom' });

		const err = await conn
			.callTool('echo', { text: 'x' }, signal(), TIMEOUT_MS)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(StreamableHTTPError);
	});

	it('a refused connection is neither class (registry may retry it)', async () => {
		const h = await startHttpServer();
		const conn = await connect(httpCfg(h.url));
		await h.close();
		harnesses.splice(harnesses.indexOf(h), 1);

		const err = await conn
			.callTool('echo', { text: 'x' }, signal(), TIMEOUT_MS)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(McpError);
		expect(err).not.toBeInstanceOf(StreamableHTTPError);
	});

	it('rejects a call that outlives its timeout, as an McpError', async () => {
		const h = await startHttpServer();
		const conn = await connect(httpCfg(h.url));

		const started = Date.now();
		const err = await conn.callTool('slow', {}, signal(), 300).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(McpError);
		expect((err as McpError).code).toBe(ErrorCode.RequestTimeout);
		expect(Date.now() - started).toBeLessThan(3000);
	});
});

describe('connectMcpServer over stdio (real SDK server subprocess)', () => {
	const serverScript = fileURLToPath(new URL('./_fixtures/mcp-stdio-server.mjs', import.meta.url));

	function stdioCfg(): LoadedStdioMcpServer {
		return {
			id: 'stdio-fixture',
			displayName: 'Stdio fixture',
			auth: 'global',
			timeoutSeconds: 5,
			idleTimeoutSeconds: 0,
			deferTools: false,
			transport: 'stdio',
			command: process.execPath,
			args: [serverScript],
			env: {},
		};
	}

	it('spawns the server, lists tools and round-trips a call', async () => {
		const conn = await connect(stdioCfg());

		expect((await conn.listTools()).map((t) => t.name)).toEqual(['echo']);
		const res = await conn.callTool('echo', { text: 'yo' }, signal(), TIMEOUT_MS);
		expect(res).toEqual({ content: [{ type: 'text', text: 'stdio:yo' }], isError: false });
	});

	it('fires onClose when the connection closes', async () => {
		const conn = await connectMcpServer(stdioCfg(), TIMEOUT_MS);
		const closed = new Promise<void>((resolve) => conn.onClose(resolve));

		await conn.close();

		await expect(closed).resolves.toBeUndefined();
	});
});
