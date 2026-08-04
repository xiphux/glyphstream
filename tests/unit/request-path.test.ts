import { describe, expect, it } from 'vitest';
import { routedPathname } from '$lib/server/util/request-path';

describe('routedPathname', () => {
	it('leaves an ordinary path untouched', () => {
		expect(routedPathname('/api/auth/passkey/login/verify')).toBe('/api/auth/passkey/login/verify');
		expect(routedPathname('/')).toBe('/');
	});

	it('decodes the escapes that let a request slip a prefix gate', () => {
		// The bug: `event.url.pathname` in hooks.handle is the RAW target while
		// SvelteKit routes on a decoded copy, so these reach the real handler
		// while failing a raw `startsWith` test.
		expect(routedPathname('/api/%61uth/passkey/login/verify')).toBe(
			'/api/auth/passkey/login/verify',
		);
		expect(routedPathname('/%61pi/auth/passkey/login/verify')).toBe(
			'/api/auth/passkey/login/verify',
		);
		expect(routedPathname('/api/%6dedia/abc/content')).toBe('/api/media/abc/content');
	});

	it('closes the gates it exists for', () => {
		// The three prefix tests in hooks.server.ts / security-headers.ts.
		expect(routedPathname('/api/%61uth/x').startsWith('/api/auth/')).toBe(true);
		expect(routedPathname('/%61pi/auth/x').startsWith('/api/')).toBe(true);
		expect(routedPathname('/api/%6dedia/x').startsWith('/api/media/')).toBe(true);
		// ...and the raw forms are exactly what used to defeat them.
		expect('/api/%61uth/x'.startsWith('/api/auth/')).toBe(false);
		expect('/%61pi/auth/x'.startsWith('/api/')).toBe(false);
		expect('/api/%6dedia/x'.startsWith('/api/media/')).toBe(false);
	});

	it('mirrors SvelteKit by not collapsing an encoded percent', () => {
		// kit's decode_pathname is `split('%25').map(decodeURI).join('%25')`.
		// Matching it exactly is the point: a double-encoded path must decode
		// here by precisely as much as it does for routing, so the gate and the
		// router can never disagree about the same request.
		expect(routedPathname('/api/%2561uth/x')).toBe('/api/%2561uth/x');
		expect(routedPathname('/api/%25/x')).toBe('/api/%25/x');
	});

	it('does not decode a reserved delimiter into a path segment', () => {
		// decodeURI leaves reserved characters escaped, so %2F stays %2F and
		// can't manufacture an extra segment. Same as SvelteKit.
		expect(routedPathname('/api%2Fauth/x')).toBe('/api%2Fauth/x');
	});

	it('returns the raw path rather than throwing on a malformed escape', () => {
		// decodeURI throws URIError on these; SvelteKit's own decode throws on
		// the same input and answers 400 before any route runs, so the helper
		// just has to stay total.
		expect(routedPathname('/api/%zz/x')).toBe('/api/%zz/x');
		expect(routedPathname('/api/%/x')).toBe('/api/%/x');
		expect(routedPathname('/api/%e0%a4%a/x')).toBe('/api/%e0%a4%a/x');
	});
});
