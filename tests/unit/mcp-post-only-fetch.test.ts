import { afterEach, describe, expect, it, vi } from 'vitest';

// client.ts reads __APP_VERSION__ at import time.
vi.stubGlobal('__APP_VERSION__', 'test');

import { postOnlyFetch } from '$lib/server/mcp/client';

// postOnlyFetch declines the optional server→client GET SSE stream (so the SDK
// runs POST-only) while passing every other request straight through.

afterEach(() => {
	vi.restoreAllMocks();
});

describe('postOnlyFetch', () => {
	it('answers the GET SSE stream open with a synthetic 405 (no real fetch)', async () => {
		const f = vi.fn();
		vi.stubGlobal('fetch', f);

		const res = await postOnlyFetch('https://x/mcp', {
			method: 'GET',
			headers: { Accept: 'text/event-stream' },
		});

		expect(res.status).toBe(405); // SDK reads this as "no GET stream offered"
		expect(f).not.toHaveBeenCalled(); // short-circuited; never hit the network
	});

	it('passes the POST handshake/tool requests straight through', async () => {
		const real = new Response('{}', { status: 200 });
		const f = vi.fn().mockResolvedValue(real);
		vi.stubGlobal('fetch', f);

		const res = await postOnlyFetch('https://x/mcp', {
			method: 'POST',
			headers: { Accept: 'application/json, text/event-stream' },
			body: '{}',
		});

		expect(res).toBe(real);
		expect(f).toHaveBeenCalledOnce();
	});

	it('passes a non-SSE GET through (only the event-stream GET is declined)', async () => {
		const real = new Response('ok');
		const f = vi.fn().mockResolvedValue(real);
		vi.stubGlobal('fetch', f);

		const res = await postOnlyFetch('https://x/thing', {
			method: 'GET',
			headers: { Accept: 'application/json' },
		});

		expect(res).toBe(real);
		expect(f).toHaveBeenCalledOnce();
	});
});
