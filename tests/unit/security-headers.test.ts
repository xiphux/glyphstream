import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, MEDIA_CSP } from '$lib/server/security-headers';

function apply(pathname: string): Headers {
	return applySecurityHeaders(new Response('body'), pathname).headers;
}

describe('applySecurityHeaders', () => {
	it('sets the standard headers on every response', () => {
		for (const pathname of ['/', '/chat/abc', '/api/conversations', '/api/media/xyz/content']) {
			const h = apply(pathname);
			expect(h.get('X-Content-Type-Options'), pathname).toBe('nosniff');
			expect(h.get('Referrer-Policy'), pathname).toBe('strict-origin-when-cross-origin');
			expect(h.get('X-Frame-Options'), pathname).toBe('DENY');
		}
	});

	it('adds a locked-down CSP to media responses', () => {
		// SvelteKit injects the svelte.config.js CSP at page render, so a
		// hand-built +server.ts Response carries none. Without this, a media
		// asset served with a scriptable Content-Type had nothing behind it.
		for (const pathname of [
			'/api/media/abc/content',
			'/api/media/abc/thumbnail',
			'/api/media/by-conversation/abc',
		]) {
			expect(apply(pathname).get('Content-Security-Policy'), pathname).toBe(MEDIA_CSP);
		}
	});

	it('scopes the media CSP by path so page CSPs are never clobbered', () => {
		// Setting a CSP header globally would overwrite the per-page policy
		// SvelteKit emits for SSR routes — which is the stronger policy where
		// it applies. Non-media paths must come back untouched.
		for (const pathname of ['/', '/chat/abc', '/settings/admin', '/api/conversations']) {
			expect(apply(pathname).get('Content-Security-Policy'), pathname).toBeNull();
		}
	});

	it('denies scripting and subresources in the media CSP', () => {
		// `sandbox` with no allow-* tokens puts a directly-navigated media
		// response in an opaque origin with scripting off; default-src 'none'
		// stops it pulling anything further.
		expect(MEDIA_CSP).toContain('sandbox');
		expect(MEDIA_CSP).toContain("default-src 'none'");
		expect(MEDIA_CSP).not.toMatch(/allow-(scripts|same-origin)/);
	});
});
