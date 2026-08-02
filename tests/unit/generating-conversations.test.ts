/**
 * The sidebar's generating-dot flag set. Small module, but its
 * clear-only reconcile is the load-bearing rule: the server registry
 * lingers past `done` for the auto-title task and knows nothing about
 * generations this client started a moment ago, so letting a poll
 * response *add* ids would re-light the dot on a conversation the user
 * just watched finish. Pin the asymmetry.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
	anyGenerating,
	clearGenerating,
	isGenerating,
	markGenerating,
	reconcileGenerating,
	resetGenerating,
} from '$lib/generating-conversations.svelte';

afterEach(() => {
	resetGenerating();
});

describe('mark / clear', () => {
	it('flags and unflags a conversation', () => {
		expect(isGenerating('c1')).toBe(false);
		markGenerating('c1');
		expect(isGenerating('c1')).toBe(true);
		clearGenerating('c1');
		expect(isGenerating('c1')).toBe(false);
	});

	it('is idempotent in both directions', () => {
		markGenerating('c1');
		markGenerating('c1');
		clearGenerating('c1');
		expect(isGenerating('c1')).toBe(false);
		expect(() => clearGenerating('never-marked')).not.toThrow();
	});

	it('keeps conversations independent', () => {
		markGenerating('c1');
		markGenerating('c2');
		clearGenerating('c1');
		expect(isGenerating('c1')).toBe(false);
		expect(isGenerating('c2')).toBe(true);
	});
});

describe('anyGenerating', () => {
	it('tracks whether the set is non-empty (the poll gate)', () => {
		expect(anyGenerating()).toBe(false);
		markGenerating('c1');
		markGenerating('c2');
		expect(anyGenerating()).toBe(true);
		clearGenerating('c1');
		// Still true with one left — the poll must keep running for it.
		expect(anyGenerating()).toBe(true);
		clearGenerating('c2');
		expect(anyGenerating()).toBe(false);
	});
});

describe('reconcileGenerating', () => {
	it('drops flags the server no longer reports as in flight', () => {
		markGenerating('done');
		markGenerating('still-running');
		reconcileGenerating(['still-running']);
		expect(isGenerating('done')).toBe(false);
		expect(isGenerating('still-running')).toBe(true);
	});

	it('clears everything when the server reports nothing in flight', () => {
		markGenerating('c1');
		markGenerating('c2');
		reconcileGenerating([]);
		expect(anyGenerating()).toBe(false);
	});

	it('does NOT add ids the client never marked', () => {
		// Clear-only. A generation the server knows about but this client
		// didn't start belongs to the deferred cross-client sync, not here —
		// and adding would also resurrect a just-finished conversation whose
		// registry entry is still held open by the auto-title task.
		reconcileGenerating(['started-on-another-device']);
		expect(isGenerating('started-on-another-device')).toBe(false);
		expect(anyGenerating()).toBe(false);
	});

	it('leaves a marked id alone when the server still reports it', () => {
		markGenerating('c1');
		reconcileGenerating(['c1']);
		expect(isGenerating('c1')).toBe(true);
	});

	it('ignores a malformed answer instead of treating it as "nothing is running"', () => {
		// The dangerous shape: `new Set(undefined)` is a valid EMPTY set, not a
		// throw, so an unguarded reconcile would read a body with no `ids` (a
		// proxy that drops the query string gets the plain `{conversations}`
		// response off the same handler) as "everything finished" — silently
		// wiping every dot. And since the poll is gated on the set being
		// non-empty, it would then stop, so nothing recovers until a reload.
		markGenerating('c1');
		markGenerating('c2');
		for (const bad of [undefined, null, {}, 'c1', 42]) {
			reconcileGenerating(bad as unknown as string[]);
		}
		expect(isGenerating('c1')).toBe(true);
		expect(isGenerating('c2')).toBe(true);
		expect(anyGenerating()).toBe(true);
	});
});
