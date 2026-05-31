import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	servers: [] as Array<{
		id: string;
		displayName: string;
		transport: 'stdio' | 'http';
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
	listMcpServerStates,
	getMcpServerTools,
	resetMcpRegistryForTests,
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
		const states = listMcpServerStates();
		expect(states.find((s) => s.id === 'fs')?.state).toBe('connected');
		expect(states.find((s) => s.id === 'linear')?.state).toBe('connected');
	});

	it('records a connect failure as failed without aborting boot or the other servers', async () => {
		mocks.servers = [
			{
				id: 'broken',
				displayName: 'broken',
				transport: 'stdio',
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

		const states = listMcpServerStates();
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
