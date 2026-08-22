/**
 * Which requests the service worker will serve cache-first.
 *
 * The predicate is small and the blast radius is not: matching too widely pins
 * the app to a stale build with no error anywhere, and matching too narrowly
 * silently gives back the 41-requests-per-launch this route exists to remove.
 */
import { describe, expect, it } from 'vitest';
import {
	CHUNK_CACHE_MAX_AGE_SECONDS,
	CHUNK_CACHE_MAX_ENTRIES,
	IMMUTABLE_PREFIX,
	isImmutableAsset,
} from '../../src/lib/sw/asset-route';

const at = (path: string, origin = 'https://ai.example.test') =>
	({ url: new URL(path, origin), sameOrigin: true }) as const;

describe('isImmutableAsset', () => {
	it('matches the hashed client bundle', () => {
		expect(isImmutableAsset(at('/_app/immutable/entry/start.B0jyXBhh.js'))).toBe(true);
		expect(isImmutableAsset(at('/_app/immutable/chunks/D1fbGJkp.js'))).toBe(true);
		expect(isImmutableAsset(at('/_app/immutable/assets/0.OkT7SBmO.css'))).toBe(true);
	});

	it('does NOT match /_app/version.json', () => {
		// SvelteKit polls this to notice a deploy. Serving it cache-first would pin
		// the app to the version it first saw and disable update detection — a
		// failure that looks like "updates stopped working" with nothing logged.
		expect(isImmutableAsset(at('/_app/version.json'))).toBe(false);
	});

	it('does not match SSR documents, the API, or the worker itself', () => {
		// A cache-first document would serve yesterday's conversation list; a
		// cache-first /api/* would break every mutation; a cache-first
		// service-worker.js would make the app un-updatable.
		expect(isImmutableAsset(at('/'))).toBe(false);
		expect(isImmutableAsset(at('/chat/abc'))).toBe(false);
		expect(isImmutableAsset(at('/api/conversations'))).toBe(false);
		expect(isImmutableAsset(at('/service-worker.js'))).toBe(false);
		expect(isImmutableAsset(at('/manifest.webmanifest'))).toBe(false);
	});

	it('does not match a cross-origin URL that happens to share the path', () => {
		// Someone else's /_app/immutable/ is not ours, and caching an opaque
		// cross-origin response would hand out bytes we never validated.
		expect(
			isImmutableAsset({
				url: new URL('https://evil.example/_app/immutable/x.js'),
				sameOrigin: false,
			}),
		).toBe(false);
	});

	it('is not fooled by the prefix appearing later in the path', () => {
		expect(isImmutableAsset(at('/media/_app/immutable/x.js'))).toBe(false);
	});

	it('keeps room for more than one build', () => {
		// A deploy must not evict the chunks the still-open page is running from;
		// a build is ~89 entries.
		expect(CHUNK_CACHE_MAX_ENTRIES).toBeGreaterThan(89 * 2 - 1);
		expect(CHUNK_CACHE_MAX_AGE_SECONDS).toBeGreaterThan(60 * 60 * 24 * 7);
		expect(IMMUTABLE_PREFIX.endsWith('/')).toBe(true);
	});
});
