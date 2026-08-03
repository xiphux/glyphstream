/**
 * Authorization on the MCP reconnect route.
 *
 * A `global` server has ONE process-wide connection shared by every user, and
 * retry closes it before re-handshaking. Left open to any signed-in user, that
 * was a lever to drop everyone else's connection — loopable, so it could break
 * other users' in-flight tool calls. A `per_user` retry only touches the
 * caller's own connection, so it stays open to its owner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	cfg: null as { auth?: string } | null,
	retryResult: { state: 'connected', error: null as string | null },
}));

const retryMcpServerMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/mcp/registry', () => ({
	getMcpServerCfg: () => mocks.cfg,
	retryMcpServer: retryMcpServerMock,
}));
vi.mock('$lib/server/mcp/tool-bridge', () => ({ registerMcpServerTools: vi.fn() }));

import { POST } from '../../src/routes/api/mcp/servers/[id]/reconnect/+server';

function mkEvent(role: 'admin' | 'user' | null, id = 'srv') {
	return {
		params: { id },
		locals: {
			user: role ? { id: 'u1', displayName: null, email: null, role } : null,
			sessionId: role ? 's1' : null,
		},
	};
}

async function statusOf(fn: () => unknown): Promise<number> {
	try {
		await fn();
		return 200;
	} catch (e) {
		const err = e as { status?: number };
		if (typeof err.status === 'number') return err.status;
		throw e;
	}
}

beforeEach(() => {
	retryMcpServerMock.mockReset();
	retryMcpServerMock.mockResolvedValue(mocks.retryResult);
	mocks.retryResult = { state: 'connected', error: null };
	mocks.cfg = { auth: 'global' };
});

describe('POST /api/mcp/servers/[id]/reconnect', () => {
	it('401s when unauthenticated', async () => {
		expect(await statusOf(() => POST(mkEvent(null) as never))).toBe(401);
		expect(retryMcpServerMock).not.toHaveBeenCalled();
	});

	it('403s a non-admin retrying a shared (global) server', async () => {
		mocks.cfg = { auth: 'global' };
		expect(await statusOf(() => POST(mkEvent('user') as never))).toBe(403);
		// The point is that the shared connection is never closed.
		expect(retryMcpServerMock).not.toHaveBeenCalled();
	});

	it('treats a server with no explicit auth as global', async () => {
		// `auth` defaults to "global" in config.toml, so an omitted field must
		// not fall through to the permissive branch.
		mocks.cfg = {};
		expect(await statusOf(() => POST(mkEvent('user') as never))).toBe(403);
		expect(retryMcpServerMock).not.toHaveBeenCalled();
	});

	it('allows an admin to retry a global server', async () => {
		mocks.cfg = { auth: 'global' };
		expect(await statusOf(() => POST(mkEvent('admin') as never))).toBe(200);
		expect(retryMcpServerMock).toHaveBeenCalledWith('srv', 'u1');
	});

	it('allows any user to retry their own per_user server', async () => {
		mocks.cfg = { auth: 'per_user' };
		expect(await statusOf(() => POST(mkEvent('user') as never))).toBe(200);
		expect(retryMcpServerMock).toHaveBeenCalledWith('srv', 'u1');
	});

	it('withholds a global server’s handshake error from non-admins', async () => {
		// The raw error names operator-configured infrastructure — upstream
		// host, port, HTTP status. An admin can read config.toml already.
		mocks.cfg = { auth: 'per_user' };
		retryMcpServerMock.mockResolvedValue({
			state: 'failed',
			error: 'connect ECONNREFUSED 10.0.0.5:8931',
		});
		const ownRetry = (await POST(mkEvent('user') as never)) as Response;
		expect((await ownRetry.json()).error).toContain('ECONNREFUSED');

		mocks.cfg = { auth: 'global' };
		const adminRetry = (await POST(mkEvent('admin') as never)) as Response;
		expect((await adminRetry.json()).error).toContain('ECONNREFUSED');
	});
});
