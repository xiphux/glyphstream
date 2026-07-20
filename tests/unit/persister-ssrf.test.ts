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
vi.mock('$lib/server/endpoints/client', async (orig) => ({
	...(await orig<typeof import('$lib/server/endpoints/client')>()),
	fetchUpstreamBytes: mocks.fetchUpstreamBytes,
}));
vi.mock('$lib/server/media/disk-store', () => ({
	getMediaStore: () => ({
		put: vi.fn(async () => ({ storagePath: 'p', contentType: 'image/png', byteSize: 3 })),
	}),
}));
vi.mock('$lib/server/db/queries/media', () => ({
	insertMedia: vi.fn(() => ({ id: 'media-1' })),
}));

import { persistGeneratedImage } from '$lib/server/media/persister';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

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
});
