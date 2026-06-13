/**
 * Per-user MCP servers (auth = "per_user"). The properties that matter:
 *   - they are NOT connected at boot (no credential to connect with);
 *   - each user gets their own connection keyed by (serverId, userId),
 *     carrying that user's own token (no cross-user token bleed);
 *   - a user with no credential reports `needs-credential`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	servers: [] as unknown[],
	connectImpl: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	credentials: new Map<string, string>(), // `${userId}:${serverId}` -> token
}));

vi.mock('$lib/server/mcp/config', () => ({
	loadMcpServers: () => mocks.servers,
}));
vi.mock('$lib/server/mcp/client', () => ({
	connectMcpServer: (...args: unknown[]) => mocks.connectImpl(...args),
}));
vi.mock('$lib/server/db/queries/mcp-credentials', () => ({
	getMcpCredential: (userId: string, serverId: string) =>
		mocks.credentials.get(`${userId}:${serverId}`) ?? null,
}));

import {
	initializeMcpServers,
	callMcpTool,
	getUserServerStates,
	resetMcpRegistryForTests,
} from '$lib/server/mcp/registry';

function fakeConnection(label: string) {
	return {
		listTools: vi.fn(async () => [
			{ name: `tool_${label}`, description: '', inputSchema: { type: 'object' } },
		]),
		callTool: vi.fn(async () => ({ content: [{ type: 'text', text: label }], isError: false })),
		close: vi.fn(async () => {}),
		onClose: vi.fn(),
	};
}

const PER_USER_SERVER = {
	id: 'mail',
	displayName: 'Mail',
	transport: 'http' as const,
	auth: 'per_user' as const,
	url: 'https://mail.example/mcp',
	apiKey: null,
	timeoutSeconds: 30,
	idleTimeoutSeconds: 900,
};

beforeEach(() => {
	mocks.servers = [PER_USER_SERVER];
	mocks.connectImpl.mockReset();
	mocks.credentials = new Map();
});
afterEach(async () => {
	await resetMcpRegistryForTests();
});

describe('per-user MCP servers', () => {
	it('does not connect a per-user server at boot', async () => {
		await initializeMcpServers();
		expect(mocks.connectImpl).not.toHaveBeenCalled();
	});

	it('reports needs-credential for a user with no token', async () => {
		await initializeMcpServers();
		const states = await getUserServerStates('userA');
		const mail = states.find((s) => s.id === 'mail');
		expect(mail?.state).toBe('needs-credential');
		expect(mail?.configured).toBe(false);
		expect(mail?.tools).toEqual([]);
	});

	it('connects each user with their own token, keyed separately', async () => {
		mocks.credentials.set('userA:mail', 'token-A');
		mocks.credentials.set('userB:mail', 'token-B');
		const connA = fakeConnection('A');
		const connB = fakeConnection('B');
		mocks.connectImpl.mockImplementation(async (...args: unknown[]) => {
			const cfg = args[0] as { apiKey: string | null };
			return cfg.apiKey === 'token-A' ? connA : connB;
		});
		await initializeMcpServers();

		const ac = new AbortController();
		const rA = await callMcpTool('mail', 'userA', 'tool_A', {}, ac.signal);
		const rB = await callMcpTool('mail', 'userB', 'tool_B', {}, ac.signal);

		// Each user's connection carried THEIR token.
		const tokensUsed = mocks.connectImpl.mock.calls.map((c) => (c[0] as { apiKey: string }).apiKey);
		expect(new Set(tokensUsed)).toEqual(new Set(['token-A', 'token-B']));
		// Two distinct connections — no cross-user reuse.
		expect(connA.callTool).toHaveBeenCalledTimes(1);
		expect(connB.callTool).toHaveBeenCalledTimes(1);
		expect(rA.isError).toBe(false);
		expect(rB.isError).toBe(false);
	});

	it('errors a tool call when the caller has no credential', async () => {
		await initializeMcpServers();
		const ac = new AbortController();
		await expect(callMcpTool('mail', 'userA', 'tool_A', {}, ac.signal)).rejects.toThrow(
			/no credential/,
		);
	});
});
