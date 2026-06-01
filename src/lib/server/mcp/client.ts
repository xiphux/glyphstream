import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LoadedMcpServer } from './config';

export interface McpToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export type McpContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }
	| { type: 'audio'; data: string; mimeType: string }
	| { type: 'resource'; resource: unknown }
	| { type: string; [k: string]: unknown };

export interface McpCallResult {
	content: McpContentBlock[];
	isError: boolean;
}

/**
 * A thin wrapper around an MCP SDK Client + its transport. Hides the
 * transport-vs-Client split from the registry so connection lifecycle
 * logic is transport-agnostic.
 */
export interface McpConnection {
	listTools(): Promise<McpToolDescriptor[]>;
	callTool(
		name: string,
		args: unknown,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<McpCallResult>;
	close(): Promise<void>;
	/** Subscribe to transport-level close events (subprocess died, HTTP session expired). */
	onClose(cb: () => void): void;
}

/**
 * Spawn the configured MCP server, complete the protocol handshake, and
 * return a connection wrapper. Throws on any failure (caller catches and
 * records).
 *
 * For Streamable HTTP transports this auto-retries the handshake once on
 * a "Session not found" response. Per the MCP spec, the client is meant
 * to discard a stale session ID and re-initialize when it sees this; the
 * @modelcontextprotocol/sdk doesn't do that automatically. At boot we
 * have no session ID of our own to clear, but the upstream's session
 * affinity may need a second roll — Fastmail's MCP, for example, load-
 * balances such that `initialize` and `notifications/initialized` can
 * land on different replicas, and the second one rejects the session
 * the first one just minted. Rebuilding the Client + transport and
 * trying again clears the SDK's internal `_sessionId` for free.
 */
export async function connectMcpServer(
	cfg: LoadedMcpServer,
	connectTimeoutMs: number,
): Promise<McpConnection> {
	try {
		return await openMcpConnection(cfg, connectTimeoutMs);
	} catch (err) {
		if (cfg.transport === 'http' && isSessionLostError(err)) {
			return await openMcpConnection(cfg, connectTimeoutMs);
		}
		throw err;
	}
}

/**
 * Detect a "Session not found" signal from the upstream. The spec maps
 * this to HTTP 404 + JSON-RPC code -32001, but real-world MCP servers
 * vary (Fastmail returns it as -32600 "Invalid Request"), so match on
 * the message text rather than the code.
 */
function isSessionLostError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return /session not found/i.test(err.message);
}

async function openMcpConnection(
	cfg: LoadedMcpServer,
	connectTimeoutMs: number,
): Promise<McpConnection> {
	const client = new Client(
		// __APP_VERSION__ is baked from package.json at build time (see
		// vite.config.ts). Keeps the MCP initialize handshake's
		// clientInfo.version in lockstep with the build the server's
		// actually running, instead of drifting silently on each bump.
		{ name: 'glyphstream', version: __APP_VERSION__ },
		{ capabilities: {} },
	);

	const transport =
		cfg.transport === 'stdio'
			? new StdioClientTransport({
					command: cfg.command,
					args: cfg.args,
					env: { ...getDefaultEnvironment(), ...cfg.env },
				})
			: new StreamableHTTPClientTransport(new URL(cfg.url), {
					requestInit: cfg.apiKey
						? { headers: { Authorization: `Bearer ${cfg.apiKey}` } }
						: undefined,
				});

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(new Error('MCP connect timed out')), connectTimeoutMs);
	try {
		await client.connect(transport, { signal: ac.signal });
	} catch (err) {
		await transport.close().catch(() => {});
		throw err;
	} finally {
		clearTimeout(timer);
	}

	const closeListeners: Array<() => void> = [];
	const originalOnClose = client.onclose;
	client.onclose = () => {
		try {
			originalOnClose?.();
		} finally {
			for (const cb of closeListeners) {
				try {
					cb();
				} catch {
					// listeners must not throw past us
				}
			}
		}
	};

	return {
		async listTools(): Promise<McpToolDescriptor[]> {
			const res = await client.listTools();
			return res.tools.map((t) => ({
				name: t.name,
				description: t.description ?? '',
				inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
			}));
		},

		async callTool(name, args, signal, timeoutMs): Promise<McpCallResult> {
			const res = await client.callTool(
				{ name, arguments: (args as Record<string, unknown> | undefined) ?? {} },
				undefined,
				{ signal, timeout: timeoutMs },
			);
			return {
				content: (res.content as McpContentBlock[]) ?? [],
				isError: res.isError === true,
			};
		},

		async close() {
			await client.close().catch(() => {});
		},

		onClose(cb) {
			closeListeners.push(cb);
		},
	};
}
