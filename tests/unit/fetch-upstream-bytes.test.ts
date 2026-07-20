import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:dns BEFORE importing so url-policy-base's assertHostnameRoutable
// picks up the mock. Resolution is driven per-test via `resolves`.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({
	default: { promises: { lookup: lookupMock } },
	promises: { lookup: lookupMock },
}));

import { fetchUpstreamBytes } from '$lib/server/endpoints/client';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

function endpoint(): LoadedEndpoint {
	// Only baseUrl / apiKey / requestTimeoutSeconds are read by the fetcher.
	return {
		baseUrl: 'http://backend.local:8080/v1',
		apiKey: 'sk-endpoint-secret',
		requestTimeoutSeconds: 30,
	} as unknown as LoadedEndpoint;
}

/** hostname -> resolved IP. Anything unlisted resolves to a public address. */
function resolves(map: Record<string, string>) {
	lookupMock.mockImplementation(async (host: string) => [
		{ address: map[host] ?? '8.8.8.8', family: 4 },
	]);
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function bytesResponse(body = 'PNGDATA', contentType = 'image/png') {
	return new Response(Buffer.from(body), { status: 200, headers: { 'content-type': contentType } });
}
function redirectResponse(location: string, status = 302) {
	return new Response(null, { status, headers: { location } });
}

beforeEach(() => {
	lookupMock.mockReset();
	fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

describe('fetchUpstreamBytes SSRF-guarded redirects', () => {
	it('refuses a redirect that lands on the cloud-metadata address', async () => {
		resolves({ 'cdn.evil.example': '203.0.113.9', '169.254.169.254': '169.254.169.254' });
		fetchMock.mockResolvedValueOnce(
			redirectResponse('http://169.254.169.254/latest/meta-data/iam/security-credentials/'),
		);

		await expect(
			fetchUpstreamBytes(endpoint(), 'https://cdn.evil.example/image.png', {
				guardRedirects: true,
			}),
		).rejects.toThrow(/unsafe media URL/i);

		// The redirect was fetched with manual handling (so we could re-check it),
		// and we never issued the follow-up request into the LAN.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
	});

	it('refuses a redirect into a private LAN address', async () => {
		resolves({ 'cdn.evil.example': '203.0.113.9', 'nas.internal': '192.168.1.50' });
		fetchMock.mockResolvedValueOnce(redirectResponse('http://nas.internal/admin'));

		await expect(
			fetchUpstreamBytes(endpoint(), 'https://cdn.evil.example/x.png', { guardRedirects: true }),
		).rejects.toThrow(/unsafe media URL/i);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('follows a redirect to another public host and returns the bytes', async () => {
		resolves({ 'cdn.example.com': '203.0.113.10', 'blob.public.net': '198.51.100.7' });
		fetchMock
			.mockResolvedValueOnce(redirectResponse('https://blob.public.net/real.png'))
			.mockResolvedValueOnce(bytesResponse('HELLO', 'image/png'));

		const { bytes, contentType } = await fetchUpstreamBytes(
			endpoint(),
			'https://cdn.example.com/redir.png',
			{ guardRedirects: true },
		);
		expect(bytes.toString()).toBe('HELLO');
		expect(contentType).toBe('image/png');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('does not forward the endpoint credential to an off-host redirect target', async () => {
		resolves({ 'cdn.example.com': '203.0.113.10', 'blob.public.net': '198.51.100.7' });
		fetchMock
			.mockResolvedValueOnce(redirectResponse('https://blob.public.net/real.png'))
			.mockResolvedValueOnce(bytesResponse());

		await fetchUpstreamBytes(endpoint(), 'https://cdn.example.com/redir.png', {
			guardRedirects: true,
		});

		const secondCallHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<
			string,
			string
		>;
		expect(secondCallHeaders?.Authorization).toBeUndefined();
	});

	it('does not forward the credential on a scheme-downgrade redirect to the same host', async () => {
		const tlsEndpoint = {
			baseUrl: 'https://backend.local/v1',
			apiKey: 'sk-endpoint-secret',
			requestTimeoutSeconds: 30,
		} as unknown as LoadedEndpoint;
		resolves({ 'cdn.example.com': '203.0.113.10', 'backend.local': '203.0.113.20' });
		fetchMock
			// Off-origin start → 302 to http:// on the SAME host (TLS downgrade).
			.mockResolvedValueOnce(redirectResponse('http://backend.local/leak'))
			.mockResolvedValueOnce(bytesResponse());

		await fetchUpstreamBytes(tlsEndpoint, 'https://cdn.example.com/x.png', {
			guardRedirects: true,
		});
		const downgradeHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<
			string,
			string
		>;
		// http://backend.local ≠ https://backend.local origin → no bearer leaked.
		expect(downgradeHeaders?.Authorization).toBeUndefined();
	});

	it('does forward the credential on a same-origin redirect back to the endpoint', async () => {
		const tlsEndpoint = {
			baseUrl: 'https://backend.local/v1',
			apiKey: 'sk-endpoint-secret',
			requestTimeoutSeconds: 30,
		} as unknown as LoadedEndpoint;
		resolves({ 'cdn.example.com': '203.0.113.10', 'backend.local': '203.0.113.20' });
		fetchMock
			.mockResolvedValueOnce(redirectResponse('https://backend.local/files/abc'))
			.mockResolvedValueOnce(bytesResponse());

		await fetchUpstreamBytes(tlsEndpoint, 'https://cdn.example.com/x.png', {
			guardRedirects: true,
		});
		const sameOriginHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<
			string,
			string
		>;
		expect(sameOriginHeaders?.Authorization).toBe('Bearer sk-endpoint-secret');
	});

	it('refuses an initial off-host URL that itself resolves private', async () => {
		resolves({ 'sneaky.example': '10.0.0.5' });
		fetchMock.mockResolvedValue(bytesResponse());
		await expect(
			fetchUpstreamBytes(endpoint(), 'https://sneaky.example/a.png', { guardRedirects: true }),
		).rejects.toThrow(/unsafe media URL/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('caps redirect chains', async () => {
		resolves({}); // everything public
		fetchMock.mockResolvedValue(redirectResponse('https://always.redirects/next'));
		await expect(
			fetchUpstreamBytes(endpoint(), 'https://always.redirects/start', { guardRedirects: true }),
		).rejects.toThrow(/redirects/i);
	});

	it('unguarded path follows redirects via the platform (no manual handling)', async () => {
		// The trusted same-host path lets fetch follow redirects; the backend may
		// legitimately live on localhost/LAN, so we must NOT run the routable check.
		fetchMock.mockResolvedValueOnce(bytesResponse('SAMEHOST', 'image/webp'));
		const { bytes } = await fetchUpstreamBytes(
			endpoint(),
			'http://backend.local:8080/v1/files/abc/content',
		);
		expect(bytes.toString()).toBe('SAMEHOST');
		// No redirect:'manual' → default follow; DNS routable check never invoked.
		expect(fetchMock.mock.calls[0][1]).not.toMatchObject({ redirect: 'manual' });
		expect(lookupMock).not.toHaveBeenCalled();
	});
});
