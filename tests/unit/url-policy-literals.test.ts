/**
 * IP-literal URLs: every spelling of an internal address must be refused.
 *
 * IPv4 shorthand (`2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`) is
 * normalised by the WHATWG URL parser before the policy sees it, so these
 * pin that the parser keeps doing so. IPv6 is the policy's own job: the
 * parser writes an IPv4-mapped address in hex (`::ffff:7f00:1`), and NAT64
 * and 6to4 addresses carry an IPv4 address the classifier has to unpack.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyInterpreterFetch } from '../../src/lib/server/code-interpreter/net-proxy';
import { assertHostnameRoutable, isPrivateIp } from '../../src/lib/server/tools/url-policy-base';

describe('isPrivateIp — IPv6 forms', () => {
	it.each([
		'::',
		'::1',
		'0:0:0:0:0:0:0:1',
		'0::0:1',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1', // how the URL parser writes [::ffff:127.0.0.1]
		'::ffff:a9fe:a9fe', // 169.254.169.254
		'::ffff:a00:1', // 10.0.0.1
		'::7f00:1', // deprecated IPv4-compatible 127.0.0.1
		'::ffff:0:7f00:1', // IPv4-translated (SIIT) 127.0.0.1
		'::ffff:0:a9fe:a9fe',
		'64:ff9b::a9fe:a9fe', // NAT64 to 169.254.169.254
		'64:ff9b::7f00:1',
		'64:ff9b:1::1', // local-use NAT64
		'2002:7f00:1::', // 6to4 of 127.0.0.1
		'2002:c0a8:101::1', // 6to4 of 192.168.1.1
		'2001:0:4136:e378::1', // Teredo
		'2001:db8::1', // documentation
		'fc00::1',
		'fd12:3456::1',
		'fe80::1',
		'febf::1',
		'fec0::1', // deprecated site-local
		'ff02::1',
		'FE80::1',
		'fe80::1%en0',
	])('refuses %s', (ip) => {
		expect(isPrivateIp(ip)).toBe(true);
	});

	it.each([
		'2606:4700:4700::1111',
		'2001:4860:4860::8888',
		'::ffff:808:808', // 8.8.8.8, mapped
		'::ffff:8.8.8.8',
		'64:ff9b::808:808', // NAT64 to 8.8.8.8
		'::ffff:0:808:808', // IPv4-translated 8.8.8.8
		'2002:808:808::1', // 6to4 of 8.8.8.8
	])('allows %s', (ip) => {
		expect(isPrivateIp(ip)).toBe(false);
	});

	it.each(['1::2::3', 'gggg::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', ':::', '::ffff:1.2.3.256'])(
		'fails closed on malformed %s',
		(ip) => {
			expect(isPrivateIp(ip)).toBe(true);
		},
	);
});

describe('assertHostnameRoutable — bracketed IPv6 literal', () => {
	it('judges the literal without a DNS lookup', async () => {
		await expect(assertHostnameRoutable('[2606:4700:4700::1111]')).resolves.toBeUndefined();
		await expect(assertHostnameRoutable('[::ffff:7f00:1]')).rejects.toThrow(/private/);
	});
});

describe('proxyInterpreterFetch — literal URLs never reach a loopback server', () => {
	let server: Server;
	let port: number;
	let hits = 0;

	beforeAll(async () => {
		server = createServer((_req, res) => {
			hits++;
			res.end('internal');
		});
		// `::` accepts IPv4 too (dual-stack), so one server catches both.
		await new Promise<void>((r) => server.listen(0, '::', r));
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise<void>((r) => server.close(() => r()));
	});

	it.each([
		'127.0.0.1',
		'2130706433',
		'0177.0.0.1',
		'0x7f000001',
		'0x7f.1',
		'127.1',
		'0',
		'[::1]',
		'[::ffff:127.0.0.1]',
		'[0:0:0:0:0:ffff:7f00:1]',
		'[::127.0.0.1]',
		'[::]',
	])('refuses http://%s/', async (host) => {
		await expect(
			proxyInterpreterFetch(
				{ url: `http://${host}:${port}/`, method: 'GET', headers: [], body: null },
				{ webDisabled: false, forbiddenHosts: new Set() },
			),
		).rejects.toThrow(/^Refused/);
		expect(hits).toBe(0);
	});
});
