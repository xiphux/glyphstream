import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserServerState } from '#lib/server/mcp/registry.js';

const mocks = vi.hoisted(() => ({
	states: [] as UserServerState[][],
	retries: [] as string[],
	calls: [] as unknown[],
}));
vi.mock('#lib/server/mcp/bootstrap.js', () => ({ awaitMcpReady: async () => {} }));
vi.mock('#lib/server/mcp/registry.js', () => ({
	getUserServerStates: async (_u: string, opts: unknown) => {
		mocks.calls.push(opts);
		return mocks.states.shift() ?? [];
	},
	retryMcpServer: async (id: string) => {
		mocks.retries.push(id);
		return { state: 'connected', error: null };
	},
}));

import { preflightMcp, serversInPolicy } from '#lib/server/scheduled/preflight.js';

const policy = (allowed: string[], ask: string[] = []) => ({ allowed, ask, memoryWrites: false });
function state(id: string, s: UserServerState['state'], extra: Partial<UserServerState> = {}) {
	return {
		id,
		displayName: id[0].toUpperCase() + id.slice(1),
		transport: 'http',
		auth: 'per_user',
		state: s,
		error: null,
		tools: [],
		configured: s !== 'needs-credential',
		...extra,
	} as UserServerState;
}

beforeEach(() => {
	mocks.states = [];
	mocks.retries = [];
	mocks.calls = [];
});

describe('serversInPolicy', () => {
	it('names each server once, from both lists', () => {
		expect(
			serversInPolicy(policy(['mcp__mail__search', 'mcp__mail__read'], ['mcp__cal-2__add'])),
		).toEqual(['cal-2', 'mail']);
	});
});

describe('preflightMcp', () => {
	it('passes without touching MCP when the policy names no MCP tools', async () => {
		expect(await preflightMcp('u', policy([]), [])).toEqual({ ok: true });
		expect(mocks.calls).toHaveLength(0);
	});

	it('reconnects failed per-user servers rather than circuit-breaking them', async () => {
		mocks.states.push([state('mail', 'connected')]);
		expect(await preflightMcp('u', policy(['mcp__mail__search']), [])).toEqual({ ok: true });
		expect(mocks.calls[0]).not.toHaveProperty('skipFailed');
	});

	it('names a server with no token as a credentials problem', async () => {
		mocks.states.push([state('mail', 'needs-credential')]);
		expect(await preflightMcp('u', policy(['mcp__mail__search']), [])).toMatchObject({
			ok: false,
			kind: 'mcp_credentials',
		});
	});

	it('reads a rejected token as a credentials problem too', async () => {
		mocks.states.push([state('mail', 'failed', { error: 'HTTP 401 Unauthorized' })]);
		expect(await preflightMcp('u', policy(['mcp__mail__search']), [])).toMatchObject({
			kind: 'mcp_credentials',
		});
	});

	it('fails a server that stays down', async () => {
		mocks.states.push([state('mail', 'failed', { error: 'ECONNREFUSED' })]);
		expect(await preflightMcp('u', policy(['mcp__mail__search']), [])).toEqual({
			ok: false,
			kind: 'mcp_unavailable',
			detail: 'Mail is unreachable: ECONNREFUSED',
		});
	});

	it('retries a failed global server once, then re-reads', async () => {
		mocks.states.push(
			[state('gh', 'failed', { auth: 'global' })],
			[state('gh', 'connected', { auth: 'global' })],
		);
		expect(await preflightMcp('u', policy(['mcp__gh__issues']), [])).toEqual({ ok: true });
		expect(mocks.retries).toEqual(['gh']);
	});

	it("ignores a server the run's own opt-outs switch off", async () => {
		expect(await preflightMcp('u', policy(['mcp__mail__search']), ['mcp:mail'])).toEqual({
			ok: true,
		});
		expect(mocks.calls).toHaveLength(0);
	});
});
