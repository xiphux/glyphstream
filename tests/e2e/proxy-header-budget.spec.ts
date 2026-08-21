import { test, expect } from '@playwright/test';
import { seedConversation } from './helpers';

/**
 * The response header block has to survive a reverse proxy, and the ceiling is
 * lower than it looks.
 *
 * nginx buffers an upstream's entire header block in a single `proxy_buffer_size`
 * — 4096 bytes by default, which is what a Synology reverse proxy ships. Go past
 * it and nginx does not truncate or forward: it abandons the response and serves
 * its own 502, while this server logs a perfectly ordinary 200. The operator sees
 * a broken app and a silent, healthy-looking log.
 *
 * That happened in production. SvelteKit's `Link:` preload header restates every
 * client chunk as a modulepreload hint — 46 of them, 3205 bytes — and a chat
 * document measured 4076 bytes of headers against the 4096 limit. Twenty bytes.
 * A `Set-Cookie` from a session renewal spent them.
 *
 * So this asserts the budget rather than just the absence of the header that
 * blew it: anything that grows the block back toward the cliff (a new security
 * header, another `Server-Timing` field, a longer CSP) fails here first, in a
 * run that takes seconds, instead of intermittently in production behind a proxy
 * whose logs the app cannot see.
 */
const NGINX_DEFAULT_PROXY_BUFFER_BYTES = 4096;

/**
 * Headroom for a `Set-Cookie` this particular request didn't happen to trigger.
 * A session renewal adds one, and it is what spent the last 20 bytes in
 * production — so a budget measured against a request that skipped it would sit
 * green right up to the cliff it exists to keep us away from.
 */
const SET_COOKIE_RESERVE_BYTES = 256;
const BUDGET_BYTES = NGINX_DEFAULT_PROXY_BUFFER_BYTES - SET_COOKIE_RESERVE_BYTES;

/** What nginx actually counts: status line + each `Name: value` CRLF + the
 *  terminating CRLF. Playwright's headersArray() preserves duplicates, which
 *  matters because `Set-Cookie` can legitimately repeat. */
function headerBlockBytes(headers: Array<{ name: string; value: string }>): number {
	const statusLine = 'HTTP/1.1 200 OK\r\n'.length;
	const fields = headers.reduce((n, h) => n + h.name.length + 2 + h.value.length + 2, 0);
	return statusLine + fields + 2;
}

test('a chat document fits inside a reverse proxy default header buffer', async ({
	request,
}, testInfo) => {
	// The chat route is the worst case: it pulls in the most client chunks, so
	// it carried the largest Link header and was the route that actually 502'd.
	//
	// Seeded id derives from the title, so it has to carry the project name —
	// desktop and mobile run this same spec against one shared database, and the
	// second one in would collide on the conversations primary key.
	const id = seedConversation(`Proxy header budget ${testInfo.project.name}`);
	const res = await request.get(`/chat/${id}`);
	expect(res.status()).toBe(200);

	const headers = res.headersArray();
	expect(
		headers.find((h) => h.name.toLowerCase() === 'link'),
		'the Link preload header is back; it costs ~3.2KB and the head tags already carry it',
	).toBeUndefined();

	const bytes = headerBlockBytes(headers);
	expect(bytes, `header block is ${bytes} bytes`).toBeLessThan(BUDGET_BYTES);
});

test('the home document fits too', async ({ request }) => {
	const res = await request.get('/');
	expect(res.status()).toBe(200);
	const bytes = headerBlockBytes(res.headersArray());
	expect(bytes, `header block is ${bytes} bytes`).toBeLessThan(BUDGET_BYTES);
});
