/** Tests for the pure math behind the sidebar favorites drag-and-drop. */

import { describe, expect, it, vi } from 'vitest';

// favorites-drag.svelte transitively imports $app/navigation via
// favorite-models — stub it out so the import resolves in the node
// vitest environment.
vi.mock('$app/navigation', () => ({
	invalidateAll: vi.fn(async () => {}),
}));
vi.mock('$lib/toast.svelte', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { computeAutoScrollSpeed, computeDropPosition } = await import('$lib/favorites-drag.svelte');

describe('computeDropPosition', () => {
	const rect = { top: 100, height: 40 }; // midpoint at y=120

	it('returns "before" when pointer is above the row midpoint', () => {
		expect(computeDropPosition(105, rect)).toBe('before');
		expect(computeDropPosition(119, rect)).toBe('before');
	});

	it('returns "after" when pointer is at or below the midpoint', () => {
		expect(computeDropPosition(120, rect)).toBe('after');
		expect(computeDropPosition(135, rect)).toBe('after');
	});
});

describe('computeAutoScrollSpeed', () => {
	const rect = { top: 100, bottom: 500 };

	it('returns 0 when the pointer is well inside the container', () => {
		expect(computeAutoScrollSpeed(300, rect)).toBe(0);
	});

	it('returns a negative (upward) speed near the top edge', () => {
		// At the very edge (distFromTop=0) the speed should be -maxSpeed.
		expect(computeAutoScrollSpeed(100, rect, 32, 12)).toBe(-12);
		// Just inside the zone — speed scales linearly toward zero.
		expect(computeAutoScrollSpeed(115, rect, 32, 12)).toBeLessThan(0);
		expect(computeAutoScrollSpeed(115, rect, 32, 12)).toBeGreaterThan(-12);
	});

	it('returns a positive (downward) speed near the bottom edge', () => {
		expect(computeAutoScrollSpeed(500, rect, 32, 12)).toBe(12);
		expect(computeAutoScrollSpeed(485, rect, 32, 12)).toBeGreaterThan(0);
		expect(computeAutoScrollSpeed(485, rect, 32, 12)).toBeLessThan(12);
	});

	it('returns 0 just outside the edge zone (no false-engages mid-container)', () => {
		// 32 px from top (the edge-zone width) → outside, so 0.
		expect(computeAutoScrollSpeed(132, rect, 32, 12)).toBe(0);
		expect(computeAutoScrollSpeed(468, rect, 32, 12)).toBe(0);
	});

	it('uses ceil so any non-zero ratio rounds up to at least 1 (top edge)', () => {
		// Pointer just 1px inside the 32-px zone — ratio = 1 - 31/32 ≈ 0.031.
		// 0.031 * 12 = 0.375 → ceil(0.375) = 1.
		expect(computeAutoScrollSpeed(131, rect, 32, 12)).toBe(-1);
	});
});
