import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
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
		timeoutMs: number
	): Promise<McpCallResult>;
	close(): Promise<void>;
	/** Subscribe to transport-level close events (subprocess died, HTTP session expired). */
	onClose(cb: () => void): void;
}

/**
 * Spawn the configured MCP server, complete the protocol handshake, and
 * return a connection wrapper. Throws on any failure (caller catches and
 * records).
 */
export async function connectMcpServer(
	cfg: LoadedMcpServer,
	connectTimeoutMs: number
): Promise<McpConnection> {
	const client = new Client(
		{ name: 'glyphstream', version: '0.11.0' },
		{ capabilities: {} }
	);

	const transport =
		cfg.transport === 'stdio'
			? new StdioClientTransport({
					command: cfg.command,
					args: cfg.args,
					env: { ...getDefaultEnvironment(), ...cfg.env }
				})
			: new StreamableHTTPClientTransport(new URL(cfg.url), {
					requestInit: cfg.apiKey
						? { headers: { Authorization: `Bearer ${cfg.apiKey}` } }
						: undefined
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
				inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' }
			}));
		},

		async callTool(
			name,
			args,
			signal,
			timeoutMs
		): Promise<McpCallResult> {
			const res = await client.callTool(
				{ name, arguments: (args as Record<string, unknown> | undefined) ?? {} },
				undefined,
				{ signal, timeout: timeoutMs }
			);
			return {
				content: (res.content as McpContentBlock[]) ?? [],
				isError: res.isError === true
			};
		},

		async close() {
			await client.close().catch(() => {});
		},

		onClose(cb) {
			closeListeners.push(cb);
		}
	};
}
