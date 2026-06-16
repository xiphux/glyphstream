/**
 * HMAC-signed JSON payloads for short-lived flow-carry cookies. Used
 * by `/setup`'s GitHub round-trip (display name + email + token must
 * round-trip through GitHub) and its passkey flow (prospective user
 * id + display name + email must round-trip between the options and
 * verify endpoints) without trusting the cookie value alone.
 *
 * Format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256 of the
 * payload)>`. Verifying reads both halves, recomputes the HMAC over
 * the payload using AUTH_SECRET, and rejects on mismatch via a
 * timing-safe compare. The payload's `exp` field is checked against
 * `Date.now()` so even a stolen cookie can't be replayed past its TTL.
 *
 * Not session tokens — sessions stay in the existing cookie-token /
 * DB-sha256 split. These are stateless single-use markers tied to
 * one ceremony.
 */
import type { Cookies } from '@sveltejs/kit';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { authSecret } from '../env';

function hmac(payloadB64: string): string {
	return createHmac('sha256', authSecret()).update(payloadB64).digest('base64url');
}

export function sign<T extends object>(payload: T, ttlMs: number): string {
	const body = JSON.stringify({ ...payload, exp: Date.now() + ttlMs });
	const payloadB64 = Buffer.from(body, 'utf8').toString('base64url');
	return `${payloadB64}.${hmac(payloadB64)}`;
}

/**
 * Verify a signed cookie and return its parsed payload. Returns null
 * on any failure: malformed input, signature mismatch, or expired
 * payload. Callers should not distinguish — every failure is "treat
 * this ceremony as cancelled."
 */
export function verify<T>(signed: string | undefined | null): (T & { exp: number }) | null {
	if (!signed || typeof signed !== 'string') return null;
	const idx = signed.indexOf('.');
	if (idx <= 0 || idx >= signed.length - 1) return null;
	const payloadB64 = signed.slice(0, idx);
	const tag = signed.slice(idx + 1);

	const expected = hmac(payloadB64);
	const expectedBuf = Buffer.from(expected, 'base64url');
	const tagBuf = Buffer.from(tag, 'base64url');
	if (expectedBuf.length !== tagBuf.length) return null;
	if (!timingSafeEqual(expectedBuf, tagBuf)) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const exp = (parsed as { exp?: unknown }).exp;
	if (typeof exp !== 'number' || exp < Date.now()) return null;

	return parsed as T & { exp: number };
}

/**
 * Write a short-lived flow-carry cookie with the standard hardening (httpOnly,
 * SameSite=Lax, Secure in production). The single definition of these cookie
 * attributes for the setup/join carry + OAuth-state cookies, so they can't drift
 * apart. `maxAgeSeconds` should match the signed payload's TTL so the cookie and
 * its signature expire together.
 */
export function setCarryCookie(
	cookies: Cookies,
	name: string,
	value: string,
	maxAgeSeconds: number,
): void {
	cookies.set(name, value, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: maxAgeSeconds,
	});
}
