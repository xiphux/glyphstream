/**
 * Per-conversation in-flight registry. Tiny module, but the
 * "replace-and-abort prior entry" and "only clear if the slot still
 * holds *our* entry" semantics are easy to break in a refactor and
 * would silently drop cancellation guarantees.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import {
	clearInFlight,
	getInFlight,
	registerInFlight,
	resetInFlight,
	setVideoJobId
} from '$lib/server/streaming/in-flight';

function endpoint(id: string): LoadedEndpoint {
	return {
		id,
		baseUrl: `https://${id}.example.com/v1`,
		displayName: id,
		apiKey: null,
		groupBy: 'endpoint',
		providerQuirk: 'passthrough',
		requestTimeoutSeconds: 30
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
	});

	it('makes the entry retrievable by conversation id', () => {
		const entry = registerInFlight('c1', endpoint('a'));
		expect(getInFlight('c1')).toBe(entry);
	});

	it('aborts the prior entry when re-registering the same conversation', () => {
		// UI guards against this but the registry defends in depth — without
		// it, two upstream calls could be racing for the same conversation
		// and the cancel button would only know about the newer one.
		const first = registerInFlight('c1', endpoint('a'));
		const second = registerInFlight('c1', endpoint('a'));
		expect(first.controller.signal.aborted).toBe(true);
		expect(second.controller.signal.aborted).toBe(false);
		expect(getInFlight('c1')).toBe(second);
	});
});

describe('clearInFlight', () => {
	it('removes the entry when the slot still holds the matching entry', () => {
		const entry = registerInFlight('c1', endpoint('a'));
		clearInFlight('c1', entry);
		expect(getInFlight('c1')).toBeUndefined();
	});

	it('does NOT clear when a newer entry has overwritten the slot', () => {
		// The recorder's finally-block calls clearInFlight with the entry
		// IT registered. If a newer turn has since taken the slot, clearing
		// would orphan the new generation's controller — its cancel button
		// would silently stop working. Guard against that.
		const first = registerInFlight('c1', endpoint('a'));
		const second = registerInFlight('c1', endpoint('a'));
		clearInFlight('c1', first);
		expect(getInFlight('c1')).toBe(second);
	});

	it('is a no-op when the conversation has no entry', () => {
		const ghost = registerInFlight('c2', endpoint('a'));
		resetInFlight();
		expect(() => clearInFlight('c1', ghost)).not.toThrow();
	});
});

describe('setVideoJobId', () => {
	it('stamps the job id onto the current entry', () => {
		const entry = registerInFlight('c1', endpoint('a'));
		setVideoJobId('c1', 'job-123');
		expect(entry.videoJobId).toBe('job-123');
	});

	it('no-ops when no entry exists (cancel arrived before videoCreate returned)', () => {
		expect(() => setVideoJobId('c1', 'job-123')).not.toThrow();
		expect(getInFlight('c1')).toBeUndefined();
	});
});

describe('resetInFlight', () => {
	it('aborts every entry and clears the registry', () => {
		const a = registerInFlight('c1', endpoint('e'));
		const b = registerInFlight('c2', endpoint('e'));
		resetInFlight();
		expect(a.controller.signal.aborted).toBe(true);
		expect(b.controller.signal.aborted).toBe(true);
		expect(getInFlight('c1')).toBeUndefined();
		expect(getInFlight('c2')).toBeUndefined();
	});
});
