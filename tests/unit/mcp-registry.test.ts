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

vi.mock('#lib/server/mcp/config.js', () => ({
	loadMcpServers: () => mocks.servers,
}));

// Partial mock: `connectMcpServer` is stubbed, but everything else — notably
// MAX_CONNECT_ATTEMPTS, which healthyBootstrapBudgetMs prices off — comes from
// the real module. Pinning the budget against a mocked constant would assert
// nothing.
vi.mock('#lib/server/mcp/client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/mcp/client.js')>()),
	connectMcpServer: (...args: unknown[]) => mocks.connectImpl(...args),
}));

import { MAX_CONNECT_ATTEMPTS } from '#lib/server/mcp/client.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
	healthyBootstrapBudgetMs,
	initializeMcpServers,
	listGlobalServerStates,
	getMcpServerTools,
	resetMcpRegistryForTests,
	callMcpTool,
} from '#lib/server/mcp/registry.js';

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

/**
 * The budget /api/mcp/ready uses to decide it has waited long enough.
 *
 * It must be derived, not a constant: `timeout_seconds` is per-server with a
 * floor and no ceiling, and one server can burn three of them (connectMcpServer
 * retries once on a session-lost error, then doConnect bounds listTools by the
 * same budget). A cap keyed off DEFAULT_TIMEOUT_SECONDS understates the real
 * ceiling by 3x and gives up on bootstraps that were never unhealthy.
 */
describe('healthyBootstrapBudgetMs', () => {
	const server = (over: Partial<(typeof mocks.servers)[number]>) => ({
		id: 'a',
		displayName: 'A',
		transport: 'http' as const,
		auth: 'global' as const,
		url: 'http://x',
		timeoutSeconds: 30,
		idleTimeoutSeconds: 300,
		...over,
	});

	it('allows one timeout per handshake attempt, plus one for listTools', async () => {
		mocks.servers = [server({ id: 'a', timeoutSeconds: 30 })];
		mocks.connectImpl.mockResolvedValue(fakeConnection([]));
		await initializeMcpServers();
		expect(healthyBootstrapBudgetMs()).toBe(90_000);
		// Pinned to the real constant, not to the 3 it currently multiplies out
		// to. connectMcpServer's retry count and this budget have to move
		// together — the budget going short is silent, and shows up much later
		// as /api/mcp/ready giving up on bootstraps that were never unhealthy.
		expect(healthyBootstrapBudgetMs()).toBe(30 * (MAX_CONNECT_ATTEMPTS + 1) * 1000);
	});

	it('tracks an operator-raised timeout rather than the default', async () => {
		// The case a hardcoded 30s cap gets wrong: this bootstrap is healthy for
		// up to 180s, and giving up at 30s would report `ready: false` for it.
		mocks.servers = [
			server({ id: 'a', timeoutSeconds: 30 }),
			server({ id: 'b', timeoutSeconds: 60 }),
		];
		mocks.connectImpl.mockResolvedValue(fakeConnection([]));
		await initializeMcpServers();
		expect(healthyBootstrapBudgetMs()).toBe(180_000);
	});

	it('ignores per-user servers, which bootstrap never connects', async () => {
		// Bootstrap only connects globals; a per-user server's timeout can't
		// lengthen it, so it must not inflate the budget either.
		mocks.servers = [
			server({ id: 'a', timeoutSeconds: 10 }),
			server({ id: 'b', auth: 'per_user', timeoutSeconds: 120 }),
		];
		mocks.connectImpl.mockResolvedValue(fakeConnection([]));
		await initializeMcpServers();
		expect(healthyBootstrapBudgetMs()).toBe(30_000);
	});

	it('is zero with no global servers — nothing to connect, nothing to wait for', async () => {
		mocks.servers = [];
		await initializeMcpServers();
		expect(healthyBootstrapBudgetMs()).toBe(0);
	});
});

describe('a connection whose tool listing fails', () => {
	// The transport connected (for stdio, a child process is running) but
	// listTools then failed or timed out. The entry goes `failed`; the client
	// must be closed too, or every retry of the failed entry leaks another
	// subprocess / HTTP session.
	it('closes the client it connected', async () => {
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
		const conn = fakeConnection(['read_file']);
		conn.listTools.mockRejectedValue(new Error('listTools exploded'));
		mocks.connectImpl.mockResolvedValue(conn);

		await initializeMcpServers();

		expect(listGlobalServerStates().find((s) => s.id === 'fs')?.state).toBe('failed');
		expect(conn.close).toHaveBeenCalledTimes(1);
	});
});

describe('a late close from a replaced connection', () => {
	// A stdio client's close event can arrive after the registry has already
	// replaced it (the SDK's close() can resolve before the child's 'close').
	// That stale event must not idle — and close — the replacement mid-use.
	it('leaves the current connection alone', async () => {
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
		const first = fakeConnection(['read_file']);
		const second = fakeConnection(['read_file']);
		mocks.connectImpl.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		await initializeMcpServers();

		// The first connection closes; the next call reconnects.
		for (const cb of first.closeListeners) cb();
		await callMcpTool('fs', 'u', 'read_file', {}, new AbortController().signal);
		expect(second.callTool).toHaveBeenCalledTimes(1);

		// Its close event fires again, late.
		for (const cb of first.closeListeners) cb();

		expect(second.close).not.toHaveBeenCalled();
		expect(listGlobalServerStates().find((s) => s.id === 'fs')?.state).toBe('connected');
	});
});
