/**
 * Tests for the orphan-media classifier — the rule the delete-conversation
 * pre-flight count and the actual orphan hard-delete both rely on.
 */

import { describe, expect, it } from 'vitest';
import { collectOrphanGeneratedMediaIds } from '$lib/server/db/queries/media';

describe('collectOrphanGeneratedMediaIds', () => {
	it('flags generated media whose every reference is in the row set', () => {
		const rows = [
			{ mediaId: 'm1', refCount: 1, origin: 'generated' as const, hardDeletedAt: null },
		];
		expect([...collectOrphanGeneratedMediaIds(rows)]).toEqual(['m1']);
	});

	it('counts multiple references to the same media as one orphan', () => {
		const rows = [
			{ mediaId: 'm1', refCount: 2, origin: 'generated' as const, hardDeletedAt: null },
			{ mediaId: 'm1', refCount: 2, origin: 'generated' as const, hardDeletedAt: null },
		];
		expect([...collectOrphanGeneratedMediaIds(rows)]).toEqual(['m1']);
	});

	it('does not flag media still referenced outside the row set', () => {
		const rows = [
			{ mediaId: 'm1', refCount: 3, origin: 'generated' as const, hardDeletedAt: null },
		];
		expect(collectOrphanGeneratedMediaIds(rows).size).toBe(0);
	});

	it('skips uploaded media and already-hard-deleted media', () => {
		const rows = [
			{ mediaId: 'up', refCount: 1, origin: 'uploaded' as const, hardDeletedAt: null },
			{ mediaId: 'gone', refCount: 1, origin: 'generated' as const, hardDeletedAt: 123 },
		];
		expect(collectOrphanGeneratedMediaIds(rows).size).toBe(0);
	});
});
