/**
 * Targeted coverage for `connectMcpServer`'s session-lost retry path —
 * the rest of the wrapper is a thin SDK proxy and is exercised at the
 * registry level. Mocks the SDK at the import boundary so we can drive
 * Client.connect() through the failure paths the upstream MCP servers
 * actually trigger.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	connectImpl: vi.fn<(transport: unknown, opts?: unknown) => Promise<void>>(),
	clientInstances: [] as unknown[],
	transportInstances: [] as unknown[],
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
	class Client {
		connect = vi.fn((t: unknown, o?: unknown) => mocks.connectImpl(t, o));
		close = vi.fn(async () => {});
		listTools = vi.fn(async () => ({ tools: [] }));
		callTool = vi.fn(async () => ({ content: [], isError: false }));
		onclose: undefined | (() => void) = undefined;
		constructor() {
			mocks.clientInstances.push(this);
		}
	}
	return { Client };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
	class StdioClientTransport {
		close = vi.fn(async () => {});
		constructor() {
			mocks.transportInstances.push(this);
		}
	}
	return { StdioClientTransport, getDefaultEnvironment: () => ({}) };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
	class StreamableHTTPClientTransport {
		close = vi.fn(async () => {});
		constructor() {
			mocks.transportInstances.push(this);
		}
	}
	return { StreamableHTTPClientTransport };
});

// Stub the build-time global so client.ts can import without Vite.
vi.stubGlobal('__APP_VERSION__', 'test');

import { connectMcpServer } from '$lib/server/mcp/client';
import type { LoadedHttpMcpServer, LoadedStdioMcpServer } from '$lib/server/mcp/config';

function httpCfg(): LoadedHttpMcpServer {
	return {
		id: 'fastmail',
		displayName: 'Fastmail',
		transport: 'http',
		auth: 'global',
		url: 'https://example.test/mcp',
		apiKey: 'tok',
		timeoutSeconds: 30,
		idleTimeoutSeconds: 0,
		deferTools: false,
	};
}

function stdioCfg(): LoadedStdioMcpServer {
	return {
		id: 'fs',
		displayName: 'fs',
		transport: 'stdio',
		auth: 'global',
		command: 'x',
		args: [],
		env: {},
		timeoutSeconds: 30,
		idleTimeoutSeconds: 900,
		deferTools: false,
	};
}

beforeEach(() => {
	mocks.connectImpl.mockReset();
	mocks.clientInstances.length = 0;
	mocks.transportInstances.length = 0;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('connectMcpServer session-lost retry', () => {
	it('retries the handshake once when http connect fails with "Session not found"', async () => {
		mocks.connectImpl
			.mockRejectedValueOnce(
				new Error(
					'Streamable HTTP error: Error POSTing to endpoint: {"error":{"message":"Session not found","code":-32600},"jsonrpc":"2.0","id":null}',
				),
			)
			.mockResolvedValueOnce(undefined);

		const conn = await connectMcpServer(httpCfg(), 30_000);
		expect(conn).toBeDefined();
		expect(mocks.connectImpl).toHaveBeenCalledTimes(2);
		// Two Client + transport pairs were built — the retry got a fresh
		// SDK instance, which is the whole point (the stale session ID
		// lives inside the transport).
		expect(mocks.clientInstances).toHaveLength(2);
		expect(mocks.transportInstances).toHaveLength(2);
	});

	it('propagates the second error when both attempts fail with session-lost', async () => {
		mocks.connectImpl
			.mockRejectedValueOnce(new Error('first: Session not found'))
			.mockRejectedValueOnce(new Error('second: Session not found'));

		await expect(connectMcpServer(httpCfg(), 30_000)).rejects.toThrow(/second: Session not found/);
		expect(mocks.connectImpl).toHaveBeenCalledTimes(2);
	});

	it('does not retry on unrelated handshake errors', async () => {
		mocks.connectImpl.mockRejectedValueOnce(new Error('ECONNREFUSED'));

		await expect(connectMcpServer(httpCfg(), 30_000)).rejects.toThrow(/ECONNREFUSED/);
		expect(mocks.connectImpl).toHaveBeenCalledTimes(1);
	});

	it('does not retry session-lost on stdio transports — irrelevant there', async () => {
		mocks.connectImpl.mockRejectedValueOnce(new Error('child: Session not found'));

		await expect(connectMcpServer(stdioCfg(), 30_000)).rejects.toThrow(/Session not found/);
		expect(mocks.connectImpl).toHaveBeenCalledTimes(1);
	});
});
