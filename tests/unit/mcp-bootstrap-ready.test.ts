/**
 * `isMcpReady` — the synchronous "has bootstrap settled" flag the (app) layout
 * renders against instead of awaiting the handshakes.
 *
 * The layout used to `await awaitMcpReady()`, which put every global MCP
 * server's boot handshake on the critical path of the first page render after
 * a process start — a live round trip to a third party, unbounded, in front of
 * the first thing the user sees. It now renders immediately and reports
 * `mcpSettled`, and the client comes back for the tool counts afterwards.
 *
 * Two properties make that safe, and both are here: the flag must be false
 * while bootstrap is genuinely still in flight (or the client never comes
 * back and the counts stay wrong for the session), and it must flip to true
 * even when bootstrap FAILED (or it never stops coming back).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	/** Settles the pending initializeMcpServers() call. */
	finishInit: null as null | ((err?: Error) => void),
	initCalls: 0,
	registerCalls: 0,
}));

vi.mock('$lib/server/mcp/registry', () => ({
	initializeMcpServers: () => {
		mocks.initCalls++;
		return new Promise<void>((resolve, reject) => {
			mocks.finishInit = (err?: Error) => (err ? reject(err) : resolve());
		});
	},
}));
vi.mock('$lib/server/mcp/tool-bridge', () => ({
	registerAllMcpTools: () => {
		mocks.registerCalls++;
	},
}));

const { _resetMcpBootstrapForTests, awaitMcpReady, bootstrapMcp, isMcpReady } =
	await import('$lib/server/mcp/bootstrap');

beforeEach(() => {
	_resetMcpBootstrapForTests();
	mocks.finishInit = null;
	mocks.initCalls = 0;
	mocks.registerCalls = 0;
});

describe('isMcpReady', () => {
	it('is false before bootstrap starts', () => {
		// Nothing has kicked it off, so the registry is definitionally not final.
		// A render here reports mcpSettled:false and the client follows up.
		expect(isMcpReady()).toBe(false);
	});

	it('stays false while the handshakes are still in flight', async () => {
		const ready = bootstrapMcp();
		// The exact window the layout renders inside on a cold start.
		expect(isMcpReady()).toBe(false);
		mocks.finishInit!();
		await ready;
		expect(isMcpReady()).toBe(true);
	});

	it('flips true after a bootstrap that FAILED', async () => {
		// "Done changing", not "succeeded". A config-parse blowup or an
		// unreachable server still ends the window — treating a failure as
		// perpetually-pending would have the client waiting on a transition
		// that is never coming, on every load, forever.
		const ready = bootstrapMcp();
		mocks.finishInit!(new Error('bad config'));
		await ready;
		expect(isMcpReady()).toBe(true);
		// And the failure was swallowed, not rethrown at the caller.
		expect(mocks.registerCalls).toBe(0);
	});

	it('does not re-run bootstrap once it has settled', async () => {
		const ready = bootstrapMcp();
		mocks.finishInit!();
		await ready;
		await awaitMcpReady();
		await bootstrapMcp();
		expect(mocks.initCalls).toBe(1);
		expect(mocks.registerCalls).toBe(1);
	});

	it('awaitMcpReady still blocks until settled, for the paths that need it', async () => {
		// The send path advertises tools[] off this; a half-connected registry
		// there is the payload-prefix churn CLAUDE.md warns about. Only the
		// render path opted out.
		let resolved = false;
		const waiting = awaitMcpReady().then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		mocks.finishInit!();
		await waiting;
		expect(resolved).toBe(true);
	});
});
