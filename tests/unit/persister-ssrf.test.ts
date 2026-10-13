/**
 * The media persister classifies an upstream-returned absolute URL as trusted
 * (same ORIGIN as the configured endpoint → unguarded, credential forwarded) or
 * untrusted (anything else → SSRF-guarded per-hop, no credential off-origin).
 * A hostname-only check would leak the bearer to a different PORT / a scheme
 * downgrade on the endpoint host with no SSRF gate — this pins the origin rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';

const mocks = vi.hoisted(() => ({ fetchUpstreamBytes: vi.fn() }));
vi.mock('#lib/server/endpoints/client.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/client.js')>()),
	fetchUpstreamBytes: mocks.fetchUpstreamBytes,
}));
vi.mock('#lib/server/media/disk-store.js', () => ({
	getMediaStore: () => ({
		put: vi.fn(async () => ({ storagePath: 'p', contentType: 'image/png', byteSize: 3 })),
	}),
}));
vi.mock('#lib/server/db/queries/media.js', () => ({
	insertMedia: vi.fn(() => ({ id: 'media-1' })),
}));

import { persistGeneratedImage } from '#lib/server/media/persister.js';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';

const endpoint = (baseUrl: string): LoadedEndpoint =>
	({ id: 'e', baseUrl, apiKey: 'k', requestTimeoutSeconds: 30 }) as unknown as LoadedEndpoint;

beforeEach(() => {
	mocks.fetchUpstreamBytes
		.mockReset()
		.mockResolvedValue({ bytes: Buffer.from('x'), contentType: 'image/png' });
});
afterEach(() => vi.restoreAllMocks());

async function persistUrl(baseUrl: string, url: string) {
	await persistGeneratedImage({
		userId: 'u',
		endpoint: endpoint(baseUrl),
		sourceModel: 'm',
		prompt: 'p',
		urlOrB64: { url },
	});
	// The opts (3rd) arg passed to fetchUpstreamBytes carries guardRedirects.
	return mocks.fetchUpstreamBytes.mock.calls[0][2] as { guardRedirects?: boolean } | undefined;
}

describe('persister SSRF trust classification (by origin)', () => {
	it('same-origin absolute URL is trusted → unguarded', async () => {
		const opts = await persistUrl(
			'http://backend.local:8080/v1',
			'http://backend.local:8080/v1/files/a/content',
		);
		expect(opts).toEqual({ guardRedirects: false });
	});

	it('same host but DIFFERENT PORT is untrusted → guarded', async () => {
		const opts = await persistUrl('http://backend.local:8080/v1', 'http://backend.local:1234/leak');
		expect(opts).toEqual({ guardRedirects: true });
	});

	it('scheme downgrade on the same host is untrusted → guarded', async () => {
		const opts = await persistUrl('https://backend.local/v1', 'http://backend.local/leak');
		expect(opts).toEqual({ guardRedirects: true });
	});

	it('a different host (public CDN) is untrusted → guarded', async () => {
		const opts = await persistUrl('http://backend.local:8080/v1', 'https://blob.public.net/x.png');
		expect(opts).toEqual({ guardRedirects: true });
	});

	// The trust decision used to key on `url.startsWith('http')`, so anything
	// absolute that didn't start with lowercase "http" fell into the "relative"
	// branch: resolved against the endpoint base to an off-origin URL, fetched
	// unguarded, with the endpoint's credential attached.
	it('protocol-relative URL is resolved first, then untrusted → guarded', async () => {
		const opts = await persistUrl(
			'http://backend.local:8080/v1',
			'//169.254.169.254/latest/meta-data',
		);
		expect(opts).toEqual({ guardRedirects: true });
		expect(mocks.fetchUpstreamBytes.mock.calls[0][1]).toBe(
			'http://169.254.169.254/latest/meta-data',
		);
	});

	it('upper-case scheme is untrusted → guarded', async () => {
		const opts = await persistUrl('http://backend.local:8080/v1', 'HTTP://10.0.0.5:9000/internal');
		expect(opts).toEqual({ guardRedirects: true });
	});

	it('a path relative to the endpoint is trusted → unguarded', async () => {
		const opts = await persistUrl('http://backend.local:8080/v1', 'files/a/content');
		expect(opts).toEqual({ guardRedirects: false });
		expect(mocks.fetchUpstreamBytes.mock.calls[0][1]).toBe(
			'http://backend.local:8080/v1/files/a/content',
		);
	});

	it.each(['file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://backend.local/x'])(
		'refuses a non-http(s) URL: %s',
		async (url) => {
			await expect(persistUrl('http://backend.local:8080/v1', url)).rejects.toThrow(/http/);
			expect(mocks.fetchUpstreamBytes).not.toHaveBeenCalled();
		},
	);
});
