/**
 * Every response the interpreter's proxy fetches is buffered in the server's
 * own memory, so a run's downloads draw down one shared byte budget and a fetch
 * that would overdraw it is refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/server/tools/url-policy-base', async (orig) => ({
	...(await orig<typeof import('../../src/lib/server/tools/url-policy-base')>()),
	fetchRoutable: vi.fn(async () => new Response(new Uint8Array(1000))),
}));

import { proxyInterpreterFetch } from '../../src/lib/server/code-interpreter/net-proxy';
import { fetchRoutable } from '../../src/lib/server/tools/url-policy-base';

afterEach(() => vi.clearAllMocks());

// A public IP literal: no DNS, and past the SSRF check.
const request = { url: 'http://93.184.215.14/', method: 'GET', headers: [], body: null };
const policy = { webDisabled: false, forbiddenHosts: new Set<string>() };

describe('proxyInterpreterFetch byte budget', () => {
	it('draws each response from the shared budget', async () => {
		const budget = { remainingBytes: 2500, limitBytes: 2500 };
		await proxyInterpreterFetch(request, { ...policy, budget });
		await proxyInterpreterFetch(request, { ...policy, budget });
		expect(budget.remainingBytes).toBe(500);
	});

	it('refuses the response that would overdraw it', async () => {
		const budget = { remainingBytes: 1500, limitBytes: 1500 };
		await proxyInterpreterFetch(request, { ...policy, budget });
		await expect(proxyInterpreterFetch(request, { ...policy, budget })).rejects.toThrow(
			/downloaded its limit of/,
		);
	});
});

describe('proxyInterpreterFetch redirects', () => {
	it('follows them itself, so the policy re-runs on every hop', async () => {
		// The dispatcher's DNS filter never sees an IP literal; a fetch that
		// followed a redirect to http://127.0.0.1/ on its own would get there.
		const budget = { remainingBytes: 5000, limitBytes: 5000 };
		await proxyInterpreterFetch(request, { ...policy, budget });
		const calls = vi.mocked(fetchRoutable).mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0][1]?.redirect).toBe('manual');
	});
});
