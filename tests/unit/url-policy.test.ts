import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:dns BEFORE importing url-policy so the module picks it up.
// Each test's beforeEach swaps the resolver behavior.
const dnsLookupMock = vi.fn();
vi.mock('node:dns', () => ({
	default: { promises: { lookup: (...args: unknown[]) => dnsLookupMock(...args) } },
	promises: { lookup: (...args: unknown[]) => dnsLookupMock(...args) },
}));

// Mock endpoints/search config so the configured-backend test can shape
// the forbidden hosts. The module under test reads these lazily.
const loadEndpointsMock = vi.fn<() => Array<{ baseUrl: string }>>();
const loadSearchConfigMock = vi.fn<() => { url: string } | null>();
vi.mock('$lib/server/endpoints/config', () => ({
	loadEndpoints: () => loadEndpointsMock(),
	loadSearchConfig: () => loadSearchConfigMock(),
}));

import {
	assertHostnameRoutable,
	assertHttpScheme,
	assertNotConfiguredBackend,
	resetUrlPolicyCacheForTests,
	UrlPolicyError,
} from '$lib/server/tools/url-policy';

beforeEach(() => {
	dnsLookupMock.mockReset();
	loadEndpointsMock.mockReset();
	loadSearchConfigMock.mockReset();
	loadEndpointsMock.mockReturnValue([]);
	loadSearchConfigMock.mockReturnValue(null);
	resetUrlPolicyCacheForTests();
});

afterEach(() => {
	resetUrlPolicyCacheForTests();
});

describe('assertHttpScheme', () => {
	it('accepts http and https', () => {
		expect(() => assertHttpScheme(new URL('http://example.com'))).not.toThrow();
		expect(() => assertHttpScheme(new URL('https://example.com'))).not.toThrow();
	});

	it('refuses non-http(s) schemes', () => {
		// Each of these is a classic "model emits a URL hoping for a local
		// read" trick. Verify they all fail closed with UrlPolicyError so
		// the relay-level error handler can surface a model-safe message.
		const refused = [
			'file:///etc/passwd',
			'data:text/plain,hello',
			'gopher://example.com',
			'javascript:alert(1)',
			'ftp://example.com',
		];
		for (const u of refused) {
			expect(() => assertHttpScheme(new URL(u))).toThrow(UrlPolicyError);
		}
	});
});

describe('assertHostnameRoutable', () => {
	it('accepts hostnames that resolve only to globally-routable addresses', async () => {
		dnsLookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
		await expect(assertHostnameRoutable('dns.google')).resolves.toBeUndefined();
	});

	it('refuses hostnames that resolve to loopback', async () => {
		dnsLookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		await expect(assertHostnameRoutable('localhost-pretender.example')).rejects.toThrow(
			UrlPolicyError,
		);
	});

	it('refuses hostnames that resolve to AWS instance metadata address', async () => {
		// 169.254.169.254 is the prototypical SSRF target. The address
		// falls in 169.254.0.0/16 which isPrivateIp catches.
		dnsLookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
		await expect(assertHostnameRoutable('metadata.tomato')).rejects.toThrow(UrlPolicyError);
	});

	it('refuses hostnames that resolve to private RFC1918 space', async () => {
		dnsLookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
		await expect(assertHostnameRoutable('rfc1918.example')).rejects.toThrow(UrlPolicyError);
	});

	it('refuses hostnames that resolve to IPv6 loopback', async () => {
		dnsLookupMock.mockResolvedValue([{ address: '::1', family: 6 }]);
		await expect(assertHostnameRoutable('v6-localhost.example')).rejects.toThrow(UrlPolicyError);
	});

	it('refuses mixed-result lookups — any private address fails closed', async () => {
		// DNS-rebinding-style payload: one public + one private. Defensive
		// path is "if any record is bad, refuse the lot" — connecting to
		// the public address only is no defense once libc / undici picks
		// an address.
		dnsLookupMock.mockResolvedValue([
			{ address: '8.8.8.8', family: 4 },
			{ address: '10.0.0.5', family: 4 },
		]);
		await expect(assertHostnameRoutable('rebinder.example')).rejects.toThrow(UrlPolicyError);
	});
});

describe('assertNotConfiguredBackend', () => {
	it('passes through hostnames that match no configured backend', () => {
		loadEndpointsMock.mockReturnValue([{ baseUrl: 'https://bridge.internal/v1' }]);
		loadSearchConfigMock.mockReturnValue({ url: 'https://searx.internal' });
		expect(() => assertNotConfiguredBackend(new URL('https://example.com'))).not.toThrow();
	});

	it('refuses URLs whose hostname matches a configured endpoint baseUrl', () => {
		loadEndpointsMock.mockReturnValue([{ baseUrl: 'https://bridge.internal/v1' }]);
		expect(() => assertNotConfiguredBackend(new URL('https://bridge.internal/v1/models'))).toThrow(
			UrlPolicyError,
		);
		// Match is by hostname only — the path doesn't matter, the port
		// doesn't matter (different port on the same host is almost
		// certainly another internal service the model shouldn't reach).
		expect(() => assertNotConfiguredBackend(new URL('http://bridge.internal:9000/foo'))).toThrow(
			UrlPolicyError,
		);
	});

	it('refuses URLs whose hostname matches the SearxNG instance', () => {
		loadSearchConfigMock.mockReturnValue({ url: 'https://searx.internal' });
		expect(() =>
			assertNotConfiguredBackend(new URL('https://searx.internal/search?q=password')),
		).toThrow(UrlPolicyError);
	});

	it('is case-insensitive on hostname match', () => {
		// Hostnames are case-insensitive per RFC 1035; the model might
		// emit any variant.
		loadEndpointsMock.mockReturnValue([{ baseUrl: 'https://Bridge.Internal/v1' }]);
		expect(() => assertNotConfiguredBackend(new URL('https://BRIDGE.INTERNAL'))).toThrow(
			UrlPolicyError,
		);
	});

	it('caches the forbidden set across calls — config is read only once', () => {
		loadEndpointsMock.mockReturnValue([{ baseUrl: 'https://bridge.internal' }]);
		// Two calls; loadEndpoints should fire exactly once.
		assertNotConfiguredBackend(new URL('https://example.com'));
		assertNotConfiguredBackend(new URL('https://example.com'));
		expect(loadEndpointsMock).toHaveBeenCalledTimes(1);
	});

	it('handles multiple endpoints + search in the same set', () => {
		loadEndpointsMock.mockReturnValue([
			{ baseUrl: 'https://bridge-a.internal/v1' },
			{ baseUrl: 'https://bridge-b.internal/v1' },
		]);
		loadSearchConfigMock.mockReturnValue({ url: 'https://searx.internal' });
		expect(() => assertNotConfiguredBackend(new URL('https://bridge-a.internal'))).toThrow();
		expect(() => assertNotConfiguredBackend(new URL('https://bridge-b.internal'))).toThrow();
		expect(() => assertNotConfiguredBackend(new URL('https://searx.internal'))).toThrow();
		expect(() => assertNotConfiguredBackend(new URL('https://external.com'))).not.toThrow();
	});

	it('survives a malformed configured URL — skips just that entry', () => {
		// loadEndpoints validates base_url at boot, but defense-in-depth:
		// if a malformed string somehow lands in the list, we should
		// silently skip it rather than poisoning the whole forbidden set.
		loadEndpointsMock.mockReturnValue([
			{ baseUrl: 'this-is-not-a-url' },
			{ baseUrl: 'https://bridge.internal/v1' },
		]);
		expect(() => assertNotConfiguredBackend(new URL('https://bridge.internal'))).toThrow(
			UrlPolicyError,
		);
		expect(() => assertNotConfiguredBackend(new URL('https://example.com'))).not.toThrow();
	});
});
