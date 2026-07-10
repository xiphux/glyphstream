import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	servers: [] as Array<{
		id: string;
		displayName: string;
		transport: 'stdio' | 'http';
		auth: 'global' | 'per_user';
		command?: string;
		args?: string[];
		env?: Record<string, string>;
		url?: string;
		apiKey?: string | null;
		timeoutSeconds: number;
		idleTimeoutSeconds: number;
	}>,
	connectImpl: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('$lib/server/mcp/config', () => ({
	loadMcpServers: () => mocks.servers,
}));

vi.mock('$lib/server/mcp/client', () => ({
	connectMcpServer: (...args: unknown[]) => mocks.connectImpl(...args),
}));

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
	initializeMcpServers,
	listGlobalServerStates,
	getMcpServerTools,
	resetMcpRegistryForTests,
	callMcpTool,
} from '$lib/server/mcp/registry';

interface FakeConn {
	listTools: ReturnType<typeof vi.fn>;
	callTool: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	onClose: ReturnType<typeof vi.fn>;
	closeListeners: Array<() => void>;
}

function fakeConnection(toolNames: string[]): FakeConn {
	const closeListeners: Array<() => void> = [];
	return {
		listTools: vi.fn(async () =>
			toolNames.map((name) => ({ name, description: '', inputSchema: { type: 'object' } })),
		),
		callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })),
		close: vi.fn(async () => {}),
		onClose: vi.fn((cb: () => void) => {
			closeListeners.push(cb);
		}),
		closeListeners,
	};
}

beforeEach(() => {
	mocks.servers = [];
	mocks.connectImpl.mockReset();
});

afterEach(async () => {
	await resetMcpRegistryForTests();
});

describe('initializeMcpServers', () => {
	it('connects each server in parallel and lists their tools', async () => {
		mocks.servers = [
			{
				id: 'fs',
				displayName: 'fs',
				transport: 'stdio',
				auth: 'global',
				command: 'x',
				args: [],
				env: {},
				timeoutSeconds: 30,
				idleTimeoutSeconds: 900,
			},
			{
				id: 'linear',
				displayName: 'linear',
				transport: 'http',
				auth: 'global',
				url: 'https://x',
				apiKey: null,
				timeoutSeconds: 30,
				idleTimeoutSeconds: 0,
			},
		];
		const fsConn = fakeConnection(['read_file', 'list_directory']);
		const linearConn = fakeConnection(['create_issue']);
		mocks.connectImpl.mockImplementation(async (...args: unknown[]) => {
			const cfg = args[0] as { id: string };
			return cfg.id === 'fs' ? fsConn : linearConn;
		});

		await initializeMcpServers();

		expect(getMcpServerTools('fs').map((t) => t.name)).toEqual(['read_file', 'list_directory']);
		expect(getMcpServerTools('linear').map((t) => t.name)).toEqual(['create_issue']);
		const states = listGlobalServerStates();
		expect(states.find((s) => s.id === 'fs')?.state).toBe('connected');
		expect(states.find((s) => s.id === 'linear')?.state).toBe('connected');
	});

	it('records a connect failure as failed without aborting boot or the other servers', async () => {
		mocks.servers = [
			{
				id: 'broken',
				displayName: 'broken',
				transport: 'stdio',
				auth: 'global',
				command: 'nope',
				args: [],
				env: {},
				timeoutSeconds: 30,
				idleTimeoutSeconds: 900,
			},
			{
				id: 'ok',
				displayName: 'ok',
				transport: 'stdio',
				auth: 'global',
				command: 'x',
				args: [],
				env: {},
				timeoutSeconds: 30,
				idleTimeoutSeconds: 900,
			},
		];
		const okConn = fakeConnection(['read']);
		mocks.connectImpl.mockImplementation(async (...args: unknown[]) => {
			const cfg = args[0] as { id: string };
			if (cfg.id === 'broken') throw new Error('spawn failed: ENOENT');
			return okConn;
		});

		await initializeMcpServers();

		const states = listGlobalServerStates();
		const broken = states.find((s) => s.id === 'broken');
		expect(broken?.state).toBe('failed');
		expect(broken?.error).toContain('ENOENT');
		expect(broken?.tools).toEqual([]);
		expect(states.find((s) => s.id === 'ok')?.state).toBe('connected');
		expect(getMcpServerTools('broken')).toEqual([]);
		expect(getMcpServerTools('ok').map((t) => t.name)).toEqual(['read']);
	});

	it('is idempotent — repeated calls share one init promise and do not reconnect', async () => {
		mocks.servers = [
			{
				id: 'fs',
				displayName: 'fs',
				transport: 'stdio',
				auth: 'global',
				command: 'x',
				args: [],
				env: {},
				timeoutSeconds: 30,
				idleTimeoutSeconds: 900,
			},
		];
		const conn = fakeConnection(['read']);
		mocks.connectImpl.mockResolvedValue(conn);

		await Promise.all([initializeMcpServers(), initializeMcpServers(), initializeMcpServers()]);

		expect(mocks.connectImpl).toHaveBeenCalledTimes(1);
	});
});

describe('callMcpTool retry narrowing', () => {
	it('does NOT retry on McpError (timeout), propagates the error and does not mark idle', async () => {
		const sid = 'test-server';
		mocks.servers = [
			{
				id: sid,
				displayName: 'Test Server',
				transport: 'stdio',
				auth: 'global',
				command: 'x',
				args: [],
				env: {},
				timeoutSeconds: 30,
				idleTimeoutSeconds: 900,
			},
		];
		const conn = fakeConnection(['my_tool']);
		const timeoutErr = new McpError(-32001, 'Request timed out');
		conn.callTool.mockRejectedValue(timeoutErr);
		mocks.connectImpl.mockResolvedValue(conn);

		await initializeMcpServers();

		const signal = new AbortController().signal;
		await expect(callMcpTool(sid, 'user1', 'my_tool', {}, signal)).rejects.toThrow(timeoutErr);

		// callTool was called exactly once — no retry attempted
		expect(conn.callTool).toHaveBeenCalledTimes(1);
		// connectImpl was called exactly once (init only, no reconnect)
		expect(mocks.connectImpl).toHaveBeenCalledTimes(1);
		// Entry state is still 'connected' — markIdle was NOT called
		const states = listGlobalServerStates();
		expect(states.find((s) => s.id === sid)?.state).toBe('connected');
	});

	it('does NOT retry on McpError (server error), propagates the error', async () => {
		const sid = 'test-server';
		mocks.servers = [
			{
				id: sid,
				displayName: 'Test Server',
				transport: 'stdio',
				auth: 'global',
				command: 'x',
				args: [],
				env: {},
				timeoutSeconds: 30,
				idleTimeoutSeconds: 900,
			},
		];
		const conn = fakeConnection(['my_tool']);
		const serverErr = new McpError(-32603, 'Internal error');
		conn.callTool.mockRejectedValue(serverErr);
		mocks.connectImpl.mockResolvedValue(conn);

		await initializeMcpServers();

		const signal = new AbortController().signal;
		await expect(callMcpTool(sid, 'user1', 'my_tool', {}, signal)).rejects.toThrow(serverErr);

		expect(conn.callTool).toHaveBeenCalledTimes(1);
		expect(mocks.connectImpl).toHaveBeenCalledTimes(1);
	});

	it('does NOT retry on StreamableHTTPError (HTTP error status), propagates the error', async () => {
		const sid = 'test-server';
		mocks.servers = [
			{
				id: sid,
				displayName: 'Test Server',
				transport: 'http',
				auth: 'global',
				url: 'https://example.com/mcp',
				apiKey: null,
				timeoutSeconds: 30,
				idleTimeoutSeconds: 0,
			},
		];
		const conn = fakeConnection(['my_tool']);
		const httpErr = new StreamableHTTPError(502, 'Bad Gateway');
		conn.callTool.mockRejectedValue(httpErr);
		mocks.connectImpl.mockResolvedValue(conn);

		await initializeMcpServers();

		const signal = new AbortController().signal;
		await expect(callMcpTool(sid, 'user1', 'my_tool', {}, signal)).rejects.toThrow(httpErr);

		expect(conn.callTool).toHaveBeenCalledTimes(1);
		expect(mocks.connectImpl).toHaveBeenCalledTimes(1);
	});

	it('retries callTool once on a plain transport Error, using a fresh connection', async () => {
		const sid = 'test-server';
		mocks.servers = [
			{
				id: sid,
				displayName: 'Test Server',
				transport: 'stdio',
				auth: 'global',
				command: 'x',
				args: [],
				env: {},
				timeoutSeconds: 30,
				idleTimeoutSeconds: 900,
			},
		];
		const conn1 = fakeConnection(['my_tool']);
		const conn2 = fakeConnection(['my_tool']);
		conn1.callTool.mockRejectedValue(new Error('Not connected'));
		conn2.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });

		let callOrder = 0;
		mocks.connectImpl.mockImplementation(async () => {
			callOrder++;
			return callOrder === 1 ? conn1 : conn2;
		});

		await initializeMcpServers();

		const signal = new AbortController().signal;
		const result = await callMcpTool(sid, 'user1', 'my_tool', {}, signal);

		expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false });
		// First connection's callTool was called once and failed
		expect(conn1.callTool).toHaveBeenCalledTimes(1);
		// Second (fresh) connection's callTool was called once and succeeded
		expect(conn2.callTool).toHaveBeenCalledTimes(1);
		// connectImpl was called twice: init + reconnect
		expect(mocks.connectImpl).toHaveBeenCalledTimes(2);
	});
});
