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
	generationActivity,
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
			reconcileGenerating(bad as string[]);
		}
		expect(isGenerating('c1')).toBe(true);
		expect(isGenerating('c2')).toBe(true);
		expect(anyGenerating()).toBe(true);
	});
});

describe('activity', () => {
	it('defaults an unqualified mark to active', () => {
		markGenerating('c1');
		expect(generationActivity('c1')).toBe('active');
	});

	it('reports null for a conversation with nothing in flight', () => {
		expect(generationActivity('c1')).toBe(null);
	});

	it('carries a queued mark, and lets a later mark promote it', () => {
		markGenerating('c1', 'queued');
		expect(generationActivity('c1')).toBe('queued');
		// Its branch reached the front of the line.
		markGenerating('c1', 'active');
		expect(generationActivity('c1')).toBe('active');
	});

	it('clears the queued flag with the id, so a re-mark does not inherit it', () => {
		markGenerating('c1', 'queued');
		clearGenerating('c1');
		markGenerating('c1');
		expect(generationActivity('c1')).toBe('active');
	});

	it('keeps membership and activity as separate questions', () => {
		// The sidebar needs a queued row to still count as "not finished" —
		// it's the difference between a dot and no dot at all.
		markGenerating('c1', 'queued');
		expect(isGenerating('c1')).toBe(true);
		expect(anyGenerating()).toBe(true);
	});
});

describe('reconcileGenerating activity', () => {
	it('promotes a queued id the server no longer reports as queued', () => {
		// The whole point of the poll carrying activity: nothing client-side is
		// listening to a generation the user walked away from, so this is the
		// only way a waiting conversation is ever seen to start.
		markGenerating('c1', 'queued');
		reconcileGenerating(['c1'], []);
		expect(generationActivity('c1')).toBe('active');
	});

	it('demotes an id the server now reports as queued', () => {
		markGenerating('c1', 'active');
		reconcileGenerating(['c1'], ['c1']);
		expect(generationActivity('c1')).toBe('queued');
	});

	it('does not resurrect a finished id just because it appears in queuedIds', () => {
		// Clear-only stays clear-only: membership comes from the first argument
		// alone, so a contradictory answer can't re-light a dot.
		reconcileGenerating([], ['gone']);
		expect(isGenerating('gone')).toBe(false);
	});

	it('leaves activity alone when the server says nothing about it', () => {
		// A response with no `queuedIds` (a garbled body, or a server that
		// predates the field) is no information about activity — reading it as
		// "nothing is queued" would repaint every waiting thread as running.
		markGenerating('c1', 'queued');
		reconcileGenerating(['c1'], undefined as unknown as string[]);
		expect(generationActivity('c1')).toBe('queued');
	});

	it('leaves both halves alone when the membership answer is malformed', () => {
		markGenerating('c1', 'queued');
		reconcileGenerating(undefined as unknown as string[], ['c1']);
		expect(generationActivity('c1')).toBe('queued');
		expect(isGenerating('c1')).toBe(true);
	});
});
