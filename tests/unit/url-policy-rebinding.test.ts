/**
 * DNS rebinding: the SSRF pre-check resolves a hostname, then `fetch`
 * resolves it AGAIN to connect. A hostile DNS server answers the first lookup
 * with a public address and the second with a private one. `fetchRoutable`
 * closes that window by filtering the lookup the socket actually uses.
 *
 * Simulated here by making the promise lookup (the pre-check's) report a public
 * address while the callback lookup (the connect's) returns loopback, with a
 * real server listening on loopback to show whether a connection landed.
 */
import dns from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { proxyInterpreterFetch } from '../../src/lib/server/code-interpreter/net-proxy';
import { fetchRoutable } from '../../src/lib/server/tools/url-policy-base';

let server: Server;
let port: number;
let hits = 0;

beforeAll(async () => {
	server = createServer((_req, res) => {
		hits++;
		res.end('internal secret');
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
	vi.restoreAllMocks();
	hits = 0;
});

/** The pre-check sees a public address; the connect sees loopback. */
function rebind(): void {
	vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
		{ address: '93.184.215.14', family: 4 },
	] as never);
	vi.spyOn(dns, 'lookup').mockImplementation(((
		_host: string,
		opts: dns.LookupOptions,
		cb: (err: null, addrs: dns.LookupAddress[] | string, family?: number) => void,
	) => {
		const addrs = [{ address: '127.0.0.1', family: 4 }];
		if (opts.all) cb(null, addrs);
		else cb(null, addrs[0].address, 4);
	}) as never);
}

describe('fetchRoutable', () => {
	it('refuses a hostname that resolves to loopback at connect time', async () => {
		await expect(fetchRoutable(`http://localhost:${port}/`, {})).rejects.toThrow();
		expect(hits).toBe(0);
		// Control: the same request without the guard does connect.
		const res = await fetch(`http://localhost:${port}/`);
		expect(await res.text()).toBe('internal secret');
	});
});

describe('proxyInterpreterFetch under DNS rebinding', () => {
	it('never connects to the rebound private address', async () => {
		rebind();
		await expect(
			proxyInterpreterFetch(
				{ url: `http://rebind.test:${port}/`, method: 'GET', headers: [], body: null },
				{ webDisabled: false, forbiddenHosts: new Set() },
			),
		).rejects.toThrow();
		expect(hits).toBe(0);
	});

	it('treats a trailing-dot hostname as the configured backend it names', async () => {
		await expect(
			proxyInterpreterFetch(
				{ url: `http://bridge.internal.:${port}/`, method: 'GET', headers: [], body: null },
				{ webDisabled: false, forbiddenHosts: new Set(['bridge.internal']) },
			),
		).rejects.toThrow(/configured backend/);
	});
});
