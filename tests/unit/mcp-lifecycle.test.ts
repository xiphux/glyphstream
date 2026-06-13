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

import {
	initializeMcpServers,
	callMcpTool,
	listGlobalServerStates,
	resetMcpRegistryForTests,
	retryMcpServer,
} from '$lib/server/mcp/registry';

interface FakeConn {
	listTools: ReturnType<typeof vi.fn>;
	callTool: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	onClose: ReturnType<typeof vi.fn>;
	closeListeners: Array<() => void>;
}

function fakeConnection(): FakeConn {
	const closeListeners: Array<() => void> = [];
	return {
		listTools: vi.fn(async () => [
			{ name: 'do_thing', description: '', inputSchema: { type: 'object' } },
		]),
		callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })),
		close: vi.fn(async () => {}),
		onClose: vi.fn((cb: () => void) => {
			closeListeners.push(cb);
		}),
		closeListeners,
	};
}

function stdioServer(idleTimeoutSeconds: number) {
	return {
		id: 'fs',
		displayName: 'fs',
		transport: 'stdio' as const,
		auth: 'global' as const,
		command: 'x',
		args: [],
		env: {},
		timeoutSeconds: 30,
		idleTimeoutSeconds,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	mocks.servers = [];
	mocks.connectImpl.mockReset();
});

afterEach(async () => {
	vi.useRealTimers();
	await resetMcpRegistryForTests();
});

describe('idle reaper', () => {
	it('closes a stdio connection after idle_timeout_seconds of inactivity', async () => {
		mocks.servers = [stdioServer(60)];
		const conn = fakeConnection();
		mocks.connectImpl.mockResolvedValue(conn);
		await initializeMcpServers();

		expect(listGlobalServerStates()[0].state).toBe('connected');

		// Advance past the idle window. The reaper fires, closes the
		// connection, and transitions us to 'idle'.
		await vi.advanceTimersByTimeAsync(61_000);
		expect(conn.close).toHaveBeenCalledTimes(1);
		expect(listGlobalServerStates()[0].state).toBe('idle');
	});

	it('does not reap when idle_timeout_seconds = 0', async () => {
		mocks.servers = [stdioServer(0)];
		const conn = fakeConnection();
		mocks.connectImpl.mockResolvedValue(conn);
		await initializeMcpServers();

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(conn.close).not.toHaveBeenCalled();
		expect(listGlobalServerStates()[0].state).toBe('connected');
	});

	it('does not reap http transports regardless of timeout', async () => {
		mocks.servers = [
			{
				id: 'h',
				displayName: 'h',
				transport: 'http' as const,
				auth: 'global' as const,
				url: 'https://x',
				apiKey: null,
				timeoutSeconds: 30,
				idleTimeoutSeconds: 60,
			},
		];
		const conn = fakeConnection();
		mocks.connectImpl.mockResolvedValue(conn);
		await initializeMcpServers();

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(conn.close).not.toHaveBeenCalled();
		expect(listGlobalServerStates()[0].state).toBe('connected');
	});

	it('transparently re-establishes after the connection has been reaped', async () => {
		mocks.servers = [stdioServer(60)];
		const conn1 = fakeConnection();
		const conn2 = fakeConnection();
		mocks.connectImpl.mockResolvedValueOnce(conn1).mockResolvedValueOnce(conn2);
		await initializeMcpServers();

		// Reap the connection.
		await vi.advanceTimersByTimeAsync(61_000);
		expect(listGlobalServerStates()[0].state).toBe('idle');

		// Next call re-establishes; conn2.callTool runs.
		const ac = new AbortController();
		const result = await callMcpTool('fs', 'user-1', 'do_thing', {}, ac.signal);
		expect(result.isError).toBe(false);
		expect(conn2.callTool).toHaveBeenCalledTimes(1);
		expect(listGlobalServerStates()[0].state).toBe('connected');
	});
});

describe('reconnect on call failure', () => {
	it('retries exactly once on a transport-drop error', async () => {
		mocks.servers = [stdioServer(900)];
		const conn1 = fakeConnection();
		conn1.callTool.mockRejectedValueOnce(new Error('transport closed'));
		const conn2 = fakeConnection();
		mocks.connectImpl.mockResolvedValueOnce(conn1).mockResolvedValueOnce(conn2);
		await initializeMcpServers();

		const ac = new AbortController();
		const result = await callMcpTool('fs', 'user-1', 'do_thing', {}, ac.signal);

		expect(result.isError).toBe(false);
		expect(conn1.callTool).toHaveBeenCalledTimes(1);
		expect(conn2.callTool).toHaveBeenCalledTimes(1);
		expect(conn1.close).toHaveBeenCalledTimes(1);
	});

	it('surfaces the second failure if the reconnect also fails', async () => {
		mocks.servers = [stdioServer(900)];
		const conn1 = fakeConnection();
		conn1.callTool.mockRejectedValue(new Error('transport closed'));
		mocks.connectImpl
			.mockResolvedValueOnce(conn1)
			.mockRejectedValueOnce(new Error('respawn failed'));
		await initializeMcpServers();

		const ac = new AbortController();
		await expect(callMcpTool('fs', 'user-1', 'do_thing', {}, ac.signal)).rejects.toThrow();
	});

	it('does not retry if the signal was aborted', async () => {
		mocks.servers = [stdioServer(900)];
		const conn = fakeConnection();
		conn.callTool.mockRejectedValue(new Error('user aborted'));
		mocks.connectImpl.mockResolvedValue(conn);
		await initializeMcpServers();

		const ac = new AbortController();
		ac.abort();
		await expect(callMcpTool('fs', 'user-1', 'do_thing', {}, ac.signal)).rejects.toThrow();
		// Only the first attempt — no reconnect on abort.
		expect(conn.callTool).toHaveBeenCalledTimes(1);
	});
});

describe('idle reconnect', () => {
	it('promotes a failed server back to connected when a later call succeeds', async () => {
		mocks.servers = [stdioServer(900)];
		// First attempt fails (boot-time); second succeeds.
		mocks.connectImpl
			.mockRejectedValueOnce(new Error('ENOENT'))
			.mockResolvedValueOnce(fakeConnection());
		await initializeMcpServers();

		expect(listGlobalServerStates()[0].state).toBe('failed');

		const ac = new AbortController();
		const result = await callMcpTool('fs', 'user-1', 'do_thing', {}, ac.signal);
		expect(result.isError).toBe(false);
		expect(listGlobalServerStates()[0].state).toBe('connected');
	});
});

describe('retryMcpServer', () => {
	it('promotes a failed entry to connected on a successful re-handshake', async () => {
		mocks.servers = [stdioServer(900)];
		mocks.connectImpl
			.mockRejectedValueOnce(new Error('initial boot failure'))
			.mockResolvedValueOnce(fakeConnection());
		await initializeMcpServers();
		expect(listGlobalServerStates()[0].state).toBe('failed');

		const result = await retryMcpServer('fs', 'user-1');
		expect(result).toEqual({ state: 'connected', error: null });
		expect(listGlobalServerStates()[0].state).toBe('connected');
	});

	it('reports the new error when the retry also fails', async () => {
		mocks.servers = [stdioServer(900)];
		mocks.connectImpl
			.mockRejectedValueOnce(new Error('first error'))
			.mockRejectedValueOnce(new Error('second error'));
		await initializeMcpServers();
		expect(listGlobalServerStates()[0].state).toBe('failed');

		const result = await retryMcpServer('fs', 'user-1');
		expect(result).toEqual({ state: 'failed', error: 'second error' });
		expect(listGlobalServerStates()[0].state).toBe('failed');
	});

	it('tears down a connected entry and reconnects from scratch', async () => {
		mocks.servers = [stdioServer(900)];
		const conn1 = fakeConnection();
		const conn2 = fakeConnection();
		mocks.connectImpl.mockResolvedValueOnce(conn1).mockResolvedValueOnce(conn2);
		await initializeMcpServers();
		expect(listGlobalServerStates()[0].state).toBe('connected');

		const result = await retryMcpServer('fs', 'user-1');
		expect(result.state).toBe('connected');
		// Old client gets closed; new client is what's live.
		expect(conn1.close).toHaveBeenCalledTimes(1);
		expect(conn2.listTools).toHaveBeenCalledTimes(1);
	});

	it('throws when the server id is unknown', async () => {
		await expect(retryMcpServer('nope', 'user-1')).rejects.toThrow(/unknown server/);
	});
});
