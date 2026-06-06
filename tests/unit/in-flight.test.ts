/**
 * Per-conversation in-flight registry. Tiny module, but the
 * "replace-and-abort prior entry" and "only clear if the slot still
 * holds *our* entry" semantics are easy to break in a refactor and
 * would silently drop cancellation guarantees. The fan-out support adds
 * N-per-conversation keying, which must not regress the single-entry
 * (default-branch) behavior.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import {
	clearInFlight,
	DEFAULT_BRANCH,
	getInFlightEntries,
	getInFlightSince,
	registerInFlight,
	resetInFlight,
} from '$lib/server/streaming/in-flight';

function endpoint(id: string): LoadedEndpoint {
	return {
		id,
		baseUrl: `https://${id}.example.com/v1`,
		displayName: id,
		apiKey: null,
		groupBy: 'endpoint',
		providerQuirk: 'passthrough',
		requestTimeoutSeconds: 30,
		maxConcurrent: Infinity,
	} as LoadedEndpoint;
}

afterEach(() => {
	resetInFlight();
});

describe('registerInFlight', () => {
	it('returns an entry with a fresh AbortController and current start time', () => {
		const before = Date.now();
		const entry = registerInFlight('c1', endpoint('a'));
		expect(entry.controller).toBeInstanceOf(AbortController);
		expect(entry.controller.signal.aborted).toBe(false);
		expect(entry.startedAt).toBeGreaterThanOrEqual(before);
		expect(entry.endpoint.id).toBe('a');
		expect(entry.branchKey).toBe(DEFAULT_BRANCH);
	});

	it('makes the entry retrievable by conversation id', () => {
		const entry = registerInFlight('c1', endpoint('a'));
		expect(getInFlightEntries('c1')).toEqual([entry]);
	});

	it('aborts the prior entry when re-registering the same conversation+branch', () => {
		// UI guards against this but the registry defends in depth — without
		// it, two upstream calls could be racing for the same branch and the
		// cancel button would only know about the newer one.
		const first = registerInFlight('c1', endpoint('a'));
		const second = registerInFlight('c1', endpoint('a'));
		expect(first.controller.signal.aborted).toBe(true);
		expect(second.controller.signal.aborted).toBe(false);
		expect(getInFlightEntries('c1')).toEqual([second]);
	});
});

describe('fan-out: multiple branches per conversation', () => {
	it('keeps distinct branches side by side without aborting each other', () => {
		const a = registerInFlight('c1', endpoint('m1'), 'b0');
		const b = registerInFlight('c1', endpoint('m2'), 'b1');
		const c = registerInFlight('c1', endpoint('m3'), 'b2');
		expect(a.controller.signal.aborted).toBe(false);
		expect(b.controller.signal.aborted).toBe(false);
		expect(c.controller.signal.aborted).toBe(false);
		expect(new Set(getInFlightEntries('c1'))).toEqual(new Set([a, b, c]));
	});

	it('clears one branch without disturbing the others', () => {
		const a = registerInFlight('c1', endpoint('m1'), 'b0');
		const b = registerInFlight('c1', endpoint('m2'), 'b1');
		clearInFlight('c1', a);
		expect(getInFlightEntries('c1')).toEqual([b]);
	});

	it('re-registering one branch aborts only that branch', () => {
		const a = registerInFlight('c1', endpoint('m1'), 'b0');
		const b = registerInFlight('c1', endpoint('m2'), 'b1');
		const a2 = registerInFlight('c1', endpoint('m1'), 'b0');
		expect(a.controller.signal.aborted).toBe(true);
		expect(b.controller.signal.aborted).toBe(false);
		expect(new Set(getInFlightEntries('c1'))).toEqual(new Set([a2, b]));
	});
});

describe('clearInFlight', () => {
	it('removes the entry when the slot still holds the matching entry', () => {
		const entry = registerInFlight('c1', endpoint('a'));
		clearInFlight('c1', entry);
		expect(getInFlightEntries('c1')).toEqual([]);
	});

	it('does NOT clear when a newer entry has overwritten the slot', () => {
		// The recorder's finally-block calls clearInFlight with the entry
		// IT registered. If a newer turn has since taken the slot, clearing
		// would orphan the new generation's controller — its cancel button
		// would silently stop working. Guard against that.
		const first = registerInFlight('c1', endpoint('a'));
		const second = registerInFlight('c1', endpoint('a'));
		clearInFlight('c1', first);
		expect(getInFlightEntries('c1')).toEqual([second]);
	});

	it('is a no-op when the conversation has no entry', () => {
		const ghost = registerInFlight('c2', endpoint('a'));
		resetInFlight();
		expect(() => clearInFlight('c1', ghost)).not.toThrow();
	});
});

describe('getInFlightSince', () => {
	it('returns null when nothing is in flight', () => {
		expect(getInFlightSince('c1')).toBeNull();
	});

	it('returns the earliest start time across branches', () => {
		const a = registerInFlight('c1', endpoint('m1'), 'b0');
		const b = registerInFlight('c1', endpoint('m2'), 'b1');
		// Force a known ordering rather than relying on wall-clock ties.
		a.startedAt = 1000;
		b.startedAt = 2000;
		expect(getInFlightSince('c1')).toBe(1000);
	});
});

describe('resetInFlight', () => {
	it('aborts every entry across all conversations and branches', () => {
		const a = registerInFlight('c1', endpoint('e'), 'b0');
		const b = registerInFlight('c1', endpoint('e'), 'b1');
		const c = registerInFlight('c2', endpoint('e'));
		resetInFlight();
		expect(a.controller.signal.aborted).toBe(true);
		expect(b.controller.signal.aborted).toBe(true);
		expect(c.controller.signal.aborted).toBe(true);
		expect(getInFlightEntries('c1')).toEqual([]);
		expect(getInFlightEntries('c2')).toEqual([]);
	});
});
