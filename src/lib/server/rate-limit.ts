/**
 * Token-bucket rate limiting for the unauthenticated auth surface.
 *
 * The threat isn't credential guessing — session tokens are 160 bits and
 * invite tokens 256, so nobody is guessing their way in. It's CPU:
 * `POST /api/auth/passkey/login/verify` runs a full WebAuthn signature
 * verification, and it runs on the same single Node event loop that serves
 * chat SSE. Unbounded, modest request volume degrades live conversations for
 * everyone. `login/options` mints challenges just as cheaply for the caller.
 *
 * In-process `Map`, single Node process — the same tradeoff the presence and
 * in-flight registries already make. A distributed deployment would need a
 * shared store, but that's not the shape this app is built for.
 *
 * ## Client identity behind a proxy
 *
 * The bucket key is whatever `event.getClientAddress()` reports. adapter-node
 * derives that from the `ADDRESS_HEADER` env var when set, and otherwise from
 * the socket peer — which, behind the reverse proxy this app expects, is the
 * *proxy* for every request. Operators who don't set `ADDRESS_HEADER` get one
 * shared bucket for the whole instance rather than per-client isolation.
 *
 * The default limit is therefore set well above what any household or small
 * team generates: nothing under `/api/auth/*` is polled, and a full sign-in is
 * a handful of requests. A shared bucket at this ceiling still blunts a flood
 * without touching real users. Operators who want true per-client limiting
 * should set `ADDRESS_HEADER` (see docs/deployment.md).
 */
import { authRateLimitMax, authRateLimitWindowSeconds } from './env';

interface Bucket {
	/** Tokens remaining, fractional between refills. */
	tokens: number;
	/** Timestamp of the last refill, for lazy replenishment. */
	updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Sweep idle buckets so a flood of distinct addresses can't grow the map
 * without bound. A bucket at full capacity carries no state worth keeping —
 * recreating it yields exactly the same thing — so full buckets are dropped.
 * Throttled to at most once per window; the map is only walked on writes.
 */
let lastSweep = 0;

function sweep(now: number, capacity: number, windowMs: number): void {
	if (now - lastSweep < windowMs) return;
	lastSweep = now;
	for (const [key, bucket] of buckets) {
		const refilled = bucket.tokens + ((now - bucket.updatedAt) / windowMs) * capacity;
		if (refilled >= capacity) buckets.delete(key);
	}
}

export interface RateLimitDecision {
	allowed: boolean;
	/** Whole seconds until one token is available. 0 when allowed. */
	retryAfterSeconds: number;
}

const ALLOWED: RateLimitDecision = { allowed: true, retryAfterSeconds: 0 };

/**
 * Consume one token for `key`. Returns whether the request may proceed and,
 * when it may not, how long to wait.
 *
 * A max of 0 disables limiting entirely — the documented escape hatch for an
 * operator whose proxy setup makes per-address limiting counterproductive.
 *
 * `now` is injectable so tests can advance time without sleeping.
 */
export function consumeRateLimitToken(key: string, now: number = Date.now()): RateLimitDecision {
	const capacity = authRateLimitMax();
	if (capacity <= 0) return ALLOWED;
	const windowMs = authRateLimitWindowSeconds() * 1000;

	sweep(now, capacity, windowMs);

	const existing = buckets.get(key);
	if (!existing) {
		buckets.set(key, { tokens: capacity - 1, updatedAt: now });
		return ALLOWED;
	}

	// Lazy refill: credit the fraction of the window that has elapsed, capped
	// at capacity so an idle bucket can't bank extra burst.
	const refill = ((now - existing.updatedAt) / windowMs) * capacity;
	const tokens = Math.min(capacity, existing.tokens + refill);
	existing.updatedAt = now;

	if (tokens < 1) {
		existing.tokens = tokens;
		// Time for the bucket to earn its next whole token.
		const msPerToken = windowMs / capacity;
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, Math.ceil(((1 - tokens) * msPerToken) / 1000)),
		};
	}

	existing.tokens = tokens - 1;
	return ALLOWED;
}

/** Test seam: forget every bucket. */
export function resetRateLimits(): void {
	buckets.clear();
	lastSweep = 0;
}

/** Test/diagnostic seam: how many addresses currently hold a bucket. */
export function rateLimitBucketCount(): number {
	return buckets.size;
}
