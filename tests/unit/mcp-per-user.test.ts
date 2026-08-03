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
	reapUserConnectionForTests,
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

describe('send-path connect does not wait for a server whose tools are known', () => {
	/**
	 * A reaped connection keeps its last tool list, and `ensureConnected` carries
	 * it into the reconnecting entry — so a server we've talked to before can
	 * advertise its known surface immediately while the handshake runs in the
	 * background.
	 *
	 * Waiting instead put the handshake at the front of time-to-first-token on
	 * the first turn after every idle reap, forever. Shortening the budget would
	 * be the wrong trade: a handshake that misses a tighter deadline drops that
	 * server's tools from `tools[]` for the turn, and a tool surface that changes
	 * because of *timing* is the payload churn the prefix-cache rule forbids.
	 */
	it('returns the known tool surface without awaiting a slow reconnect', async () => {
		mocks.credentials.set('userA:mail', 'tok-a');
		mocks.connectImpl.mockResolvedValue(fakeConnection('a'));
		await initializeMcpServers();

		// First call establishes the connection and learns the tools.
		const first = await getUserServerStates('userA', { connectBudgetMs: 2500 });
		expect(first[0].tools.map((t) => t.name)).toEqual(['tool_a']);

		// Reap it the way the idle timer would, then make reconnecting hang.
		await reapUserConnectionForTests('mail', 'userA');
		const released: Array<() => void> = [];
		mocks.connectImpl.mockImplementation(
			() =>
				new Promise((resolve) => {
					released.push(() => resolve(fakeConnection('a')));
				}),
		);

		const started = Date.now();
		const states = await getUserServerStates('userA', {
			connectBudgetMs: 2500,
			skipFailed: true,
			backgroundKnownServers: true,
		});
		const waited = Date.now() - started;

		// Did not sit on the hanging handshake...
		expect(waited).toBeLessThan(500);
		// ...and still advertises the surface, so `tools[]` doesn't blink.
		expect(states[0].tools.map((t) => t.name)).toEqual(['tool_a']);
		for (const release of released) release();
	});

	/**
	 * The settings page passes a budget but NOT `backgroundKnownServers`: its
	 * whole purpose is reporting whether a server is reachable *now*, so it has
	 * to wait for the handshake it triggered. Keying the no-wait split off
	 * `connectBudgetMs` instead made an idle-reaped server (which keeps its tool
	 * list) render as "Reconnecting" with a stale surface — including after it
	 * had gone down.
	 */
	it('still awaits a known server when only a budget is given', async () => {
		mocks.credentials.set('userA:mail', 'tok-a');
		mocks.connectImpl.mockResolvedValue(fakeConnection('a'));
		await initializeMcpServers();

		await getUserServerStates('userA', { connectBudgetMs: 2500 });
		await reapUserConnectionForTests('mail', 'userA');

		let release!: () => void;
		mocks.connectImpl.mockImplementation(
			() => new Promise((resolve) => (release = () => resolve(fakeConnection('a')))),
		);

		let settled = false;
		const pending = getUserServerStates('userA', { connectBudgetMs: 2500 }).then((s) => {
			settled = true;
			return s;
		});
		await new Promise((r) => setTimeout(r, 50));
		expect(settled, 'settings page returned without awaiting the reconnect').toBe(false);

		release();
		const states = await pending;
		expect(states[0].state).toBe('connected');
	});
});
