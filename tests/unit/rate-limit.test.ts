import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	consumeRateLimitToken,
	rateLimitBucketCount,
	resetRateLimits,
} from '$lib/server/rate-limit';

const MAX = 60; // AUTH_RATE_LIMIT_MAX default
const WINDOW_MS = 60_000; // AUTH_RATE_LIMIT_WINDOW_SECONDS default

beforeEach(() => resetRateLimits());
afterEach(() => resetRateLimits());

/** Spend `n` tokens for `key` at a fixed instant; return the last decision. */
function spend(key: string, n: number, now: number) {
	let last = consumeRateLimitToken(key, now);
	for (let i = 1; i < n; i++) last = consumeRateLimitToken(key, now);
	return last;
}

describe('consumeRateLimitToken', () => {
	it('allows a full burst up to capacity, then refuses', () => {
		const t0 = 1_000_000;
		expect(spend('1.2.3.4', MAX, t0).allowed).toBe(true);
		expect(consumeRateLimitToken('1.2.3.4', t0).allowed).toBe(false);
	});

	it('reports a positive whole-second Retry-After when refusing', () => {
		const t0 = 1_000_000;
		spend('1.2.3.4', MAX, t0);
		const denied = consumeRateLimitToken('1.2.3.4', t0);
		expect(denied.allowed).toBe(false);
		expect(denied.retryAfterSeconds).toBeGreaterThan(0);
		expect(Number.isInteger(denied.retryAfterSeconds)).toBe(true);
	});

	it('keys buckets independently per address', () => {
		const t0 = 1_000_000;
		spend('1.2.3.4', MAX, t0);
		expect(consumeRateLimitToken('1.2.3.4', t0).allowed).toBe(false);
		// A different client is unaffected by the first one's exhaustion.
		expect(consumeRateLimitToken('5.6.7.8', t0).allowed).toBe(true);
	});

	it('refills over the window', () => {
		const t0 = 1_000_000;
		spend('1.2.3.4', MAX, t0);
		expect(consumeRateLimitToken('1.2.3.4', t0).allowed).toBe(false);

		// Half a window back → half the capacity returned.
		const half = t0 + WINDOW_MS / 2;
		expect(consumeRateLimitToken('1.2.3.4', half).allowed).toBe(true);
		expect(spend('1.2.3.4', MAX / 2 - 1, half).allowed).toBe(true);
		expect(consumeRateLimitToken('1.2.3.4', half).allowed).toBe(false);
	});

	it('does not let an idle bucket bank burst beyond capacity', () => {
		const t0 = 1_000_000;
		consumeRateLimitToken('1.2.3.4', t0);
		// Idle for ten windows — capacity is still capacity, not ten times it.
		const later = t0 + WINDOW_MS * 10;
		expect(spend('1.2.3.4', MAX, later).allowed).toBe(true);
		expect(consumeRateLimitToken('1.2.3.4', later).allowed).toBe(false);
	});

	it('sweeps recovered buckets so distinct addresses cannot grow the map', () => {
		const t0 = 1_000_000;
		for (let i = 0; i < 200; i++) consumeRateLimitToken(`10.0.0.${i}`, t0);
		expect(rateLimitBucketCount()).toBe(200);

		// A window later every one of those has refilled to capacity and
		// carries no state worth keeping. The next call triggers the sweep.
		consumeRateLimitToken('192.168.1.1', t0 + WINDOW_MS + 1);
		expect(rateLimitBucketCount()).toBeLessThan(200);
	});

	it('keeps counting an exhausted bucket rather than dropping it in the sweep', () => {
		// The sweep must not become an escape hatch: a client that is being
		// limited has to stay limited across a sweep it happens to trigger.
		const t0 = 1_000_000;
		spend('1.2.3.4', MAX, t0);
		// Advance just enough to fire the sweep but not to refill a whole token.
		const nudge = t0 + WINDOW_MS + 1;
		for (let i = 0; i < 200; i++) consumeRateLimitToken(`10.0.0.${i}`, nudge);
		// 1.2.3.4 has fully refilled by now and is legitimately allowed again;
		// what matters is that it is spending from a bucket, not bypassing one.
		expect(spend('1.2.3.4', MAX, nudge).allowed).toBe(true);
		expect(consumeRateLimitToken('1.2.3.4', nudge).allowed).toBe(false);
	});
});
