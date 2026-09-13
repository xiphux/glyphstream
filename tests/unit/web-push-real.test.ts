/**
 * The Web Push transport, for real: `sendPushNotification` driving the actual
 * `web-push` package against a local HTTPS push-service stub.
 *
 * push-notify.test.ts mocks this module, so web-push itself never ran in CI.
 * It's a 3.x dep whose minors auto-merge, and what it does is all protocol: a
 * change to the payload encryption (RFC 8291), the VAPID JWT (RFC 8292), or how
 * an HTTP failure surfaces as `statusCode` would merge green. The first two
 * break every notification silently — the push service accepts the request and
 * the browser discards what it can't decrypt or verify. The third breaks
 * pruning: notify.ts deletes a subscription only on a 404/410 statusCode.
 *
 * So the stub decrypts the body with the subscriber's private key and verifies
 * the JWT signature with the VAPID public key, both independently of web-push.
 */
import { execFileSync } from 'node:child_process';
import {
	createECDH,
	createHmac,
	createDecipheriv,
	createPublicKey,
	randomBytes,
	verify,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, globalAgent, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const vapid = webpush.generateVAPIDKeys();

vi.mock('$lib/server/endpoints/config', () => ({
	loadNotificationsConfig: () => ({
		vapidPublic: vapid.publicKey,
		vapidPrivate: vapid.privateKey,
		vapidSubject: 'mailto:push-test@example.com',
	}),
}));

import { _resetWebPushForTest, sendPushNotification } from '$lib/server/push/web-push';

interface Received {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: Buffer;
}

let certDir = '';
let server: Server;
let origin = '';
let nextStatus = 201;
let received: Received[] = [];
let previousCa: unknown;

// The subscriber (browser) side: a P-256 key pair and a 16-byte auth secret.
const ua = createECDH('prime256v1');
ua.generateKeys();
const authSecret = randomBytes(16);

function subscription(path = '/push/sub-1') {
	return {
		endpoint: `${origin}${path}`,
		keys: { p256dh: ua.getPublicKey('base64url'), auth: authSecret.toString('base64url') },
	};
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** RFC 8291 + RFC 8188 single-record aes128gcm decryption, written from the spec. */
function decryptAes128gcm(body: Buffer): string {
	const salt = body.subarray(0, 16);
	const idlen = body[20];
	const asPublic = body.subarray(21, 21 + idlen);
	const ciphertext = body.subarray(21 + idlen);

	const ecdhSecret = ua.computeSecret(asPublic);
	const keyInfo = Buffer.concat([
		Buffer.from('WebPush: info\0'),
		ua.getPublicKey(),
		asPublic,
		Buffer.from([1]),
	]);
	const ikm = hmac(hmac(authSecret, ecdhSecret), keyInfo);
	const prk = hmac(salt, ikm);
	const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
	const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

	const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
	decipher.setAuthTag(ciphertext.subarray(-16));
	const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
	// Last record: plaintext, then a 0x02 delimiter, then zero padding.
	const end = padded.lastIndexOf(2);
	return padded.subarray(0, end).toString('utf8');
}

/** Verify a `vapid t=<jwt>, k=<key>` header (RFC 8292) and return the JWT claims. */
function verifyVapid(header: string): Record<string, unknown> {
	const match = /^vapid t=([^,]+),\s*k=(.+)$/.exec(header);
	if (!match) throw new Error(`not a vapid authorization header: ${header}`);
	const [, jwt, k] = match;
	expect(k).toBe(vapid.publicKey);

	const [h, p, s] = jwt.split('.');
	const raw = Buffer.from(vapid.publicKey, 'base64url'); // 0x04 || x || y
	const key = createPublicKey({
		key: {
			kty: 'EC',
			crv: 'P-256',
			x: raw.subarray(1, 33).toString('base64url'),
			y: raw.subarray(33, 65).toString('base64url'),
		},
		format: 'jwk',
	});
	const ok = verify(
		'sha256',
		Buffer.from(`${h}.${p}`),
		{ key, dsaEncoding: 'ieee-p1363' },
		Buffer.from(s, 'base64url'),
	);
	expect(ok).toBe(true);
	expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toMatchObject({ alg: 'ES256' });
	return JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
}

beforeAll(async () => {
	// A throwaway self-signed cert for 127.0.0.1, generated per run — nothing
	// key-shaped is checked in. web-push only speaks https.
	certDir = mkdtempSync(join(tmpdir(), 'web-push-test-'));
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'ec',
			'-pkeyopt',
			'ec_paramgen_curve:prime256v1',
			'-nodes',
			'-days',
			'1',
			'-subj',
			'/CN=127.0.0.1',
			'-addext',
			'subjectAltName=IP:127.0.0.1',
			'-keyout',
			join(certDir, 'key.pem'),
			'-out',
			join(certDir, 'cert.pem'),
		],
		{ stdio: 'ignore' },
	);
	const cert = readFileSync(join(certDir, 'cert.pem'));

	server = createServer({ key: readFileSync(join(certDir, 'key.pem')), cert }, (req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			received.push({
				method: req.method ?? '',
				url: req.url ?? '',
				headers: req.headers,
				body: Buffer.concat(chunks),
			});
			res.writeHead(nextStatus).end();
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

	// web-push passes no agent, so its https.request uses the global agent.
	// Trust the stub's cert there (and only for this file's worker).
	previousCa = globalAgent.options.ca;
	globalAgent.options.ca = cert;
});

afterAll(async () => {
	globalAgent.options.ca = previousCa as typeof globalAgent.options.ca;
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	if (certDir) rmSync(certDir, { recursive: true, force: true });
});

beforeEach(() => {
	_resetWebPushForTest();
	received = [];
	nextStatus = 201;
});

describe('sendPushNotification (real web-push)', () => {
	it('delivers a payload the subscriber can decrypt, signed with the VAPID key', async () => {
		const payload = JSON.stringify({ title: 'Reply ready', conversationId: 'c1' });
		await expect(sendPushNotification(subscription(), payload)).resolves.toEqual({ ok: true });

		expect(received).toHaveLength(1);
		const [req] = received;
		expect(req.method).toBe('POST');
		expect(req.url).toBe('/push/sub-1');
		expect(req.headers.ttl).toBe('60');
		expect(req.headers['content-encoding']).toBe('aes128gcm');
		expect(req.body.includes(Buffer.from('Reply ready'))).toBe(false);
		expect(decryptAes128gcm(req.body)).toBe(payload);

		const claims = verifyVapid(String(req.headers.authorization));
		expect(claims.aud).toBe(origin);
		expect(claims.sub).toBe('mailto:push-test@example.com');
		expect(Number(claims.exp)).toBeGreaterThan(Date.now() / 1000);
	});

	it.each([410, 404])('reports a %i as a gone subscription (statusCode)', async (status) => {
		nextStatus = status;
		await expect(sendPushNotification(subscription(), 'x')).resolves.toEqual({
			ok: false,
			statusCode: status,
		});
	});

	it('reports a transient push-service failure with its status', async () => {
		nextStatus = 503;
		await expect(sendPushNotification(subscription(), 'x')).resolves.toEqual({
			ok: false,
			statusCode: 503,
		});
	});

	it('never throws on a network failure, and reports no statusCode', async () => {
		const closed = createServer();
		await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
		const port = (closed.address() as AddressInfo).port;
		await new Promise<void>((r) => closed.close(() => r()));

		const res = await sendPushNotification(
			{ ...subscription(), endpoint: `https://127.0.0.1:${port}/push/x` },
			'x',
		);
		expect(res.ok).toBe(false);
		expect(res.statusCode).toBeUndefined();
	});
});
