import { describe, expect, it } from 'vitest';
import { scoreMemory, selectMemoryTiers } from '$lib/server/memory/tiering';
import type { MemoryTierRow } from '$lib/server/db/queries/memories';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed epoch — pure functions take `now`, so tests are deterministic

function row(over: Partial<MemoryTierRow> & { id: string }): MemoryTierRow {
	return {
		topic: 't',
		snippet: 's',
		len: 100,
		recallCount: 0,
		lastRecalledAt: null,
		createdAt: NOW,
		updatedAt: NOW,
		...over,
	};
}

describe('scoreMemory', () => {
	it('ranks a recently-recalled memory above an equally-recalled older one', () => {
		const base = { recallCount: 5, createdAt: NOW - 100 * DAY, updatedAt: NOW - 100 * DAY };
		const recent = row({ id: 'recent', ...base, lastRecalledAt: NOW - 1 * DAY });
		const old = row({ id: 'old', ...base, lastRecalledAt: NOW - 60 * DAY });
		expect(scoreMemory(recent, NOW)).toBeGreaterThan(scoreMemory(old, NOW));
	});

	it('ranks a fresh never-recalled memory above an old never-recalled one', () => {
		const fresh = row({ id: 'fresh', createdAt: NOW - 1 * DAY, updatedAt: NOW - 1 * DAY });
		const old = row({ id: 'old', createdAt: NOW - 60 * DAY, updatedAt: NOW - 60 * DAY });
		expect(scoreMemory(fresh, NOW)).toBeGreaterThan(scoreMemory(old, NOW));
	});

	it('uses the later of created/updated for freshness (an edit refreshes)', () => {
		const edited = row({ id: 'e', createdAt: NOW - 60 * DAY, updatedAt: NOW - 1 * DAY });
		const stale = row({ id: 's', createdAt: NOW - 60 * DAY, updatedAt: NOW - 60 * DAY });
		expect(scoreMemory(edited, NOW)).toBeGreaterThan(scoreMemory(stale, NOW));
	});

	it('ignores recall_count when the memory was never recalled (null last_recalled_at)', () => {
		// A high count with a null timestamp must not contribute — the pair is
		// written together, so null means "never recalled".
		const many = row({ id: 'many', recallCount: 99, lastRecalledAt: null });
		const none = row({ id: 'none', recallCount: 0, lastRecalledAt: null });
		expect(scoreMemory(many, NOW)).toBe(scoreMemory(none, NOW));
	});

	it('is self-erasing: score strictly decreases as time passes with no new recalls', () => {
		const m = row({ id: 'm', recallCount: 5, lastRecalledAt: NOW, createdAt: NOW, updatedAt: NOW });
		expect(scoreMemory(m, NOW + 30 * DAY)).toBeLessThan(scoreMemory(m, NOW));
	});
});

describe('selectMemoryTiers', () => {
	it('makes everything hot when the whole store fits the budget', () => {
		const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]; // 3 × 100
		const { hotIds, cold } = selectMemoryTiers(rows, 4000, NOW);
		expect(hotIds.sort()).toEqual(['a', 'b', 'c']);
		expect(cold).toEqual([]);
	});

	it('greedy-fills the budget by score, overflowing the rest to cold', () => {
		// Distinct freshness → newest scores highest. Budget 250, len 100 each → two fit.
		const a = row({ id: 'a', createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY });
		const b = row({ id: 'b', createdAt: NOW - 1 * DAY, updatedAt: NOW - 1 * DAY });
		const c = row({ id: 'c', createdAt: NOW, updatedAt: NOW });
		const { hotIds, cold } = selectMemoryTiers([a, b, c], 250, NOW);
		// c and b are the two highest-scored; returned in createdAt order.
		expect(hotIds).toEqual(['b', 'c']);
		// a overflows to cold.
		expect(cold.map((r) => r.id)).toEqual(['a']);
	});

	it('returns cold sorted by createdAt regardless of score order', () => {
		const a = row({ id: 'a', len: 100, createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY });
		const b = row({ id: 'b', len: 100, createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY });
		const c = row({ id: 'c', len: 100, createdAt: NOW - 1 * DAY, updatedAt: NOW - 1 * DAY });
		// Budget fits only the single freshest (c); a and b are cold, oldest-first.
		const { hotIds, cold } = selectMemoryTiers([a, b, c], 100, NOW);
		expect(hotIds).toEqual(['c']);
		expect(cold.map((r) => r.id)).toEqual(['a', 'b']);
	});

	it('strict prefix: a top-scored row too big to fit blocks the rest (all cold)', () => {
		const big = row({ id: 'big', len: 5000, createdAt: NOW, updatedAt: NOW }); // freshest, huge
		const small = row({
			id: 'small',
			len: 100,
			createdAt: NOW - 1 * DAY,
			updatedAt: NOW - 1 * DAY,
		});
		const { hotIds, cold } = selectMemoryTiers([big, small], 4000, NOW);
		expect(hotIds).toEqual([]);
		expect(cold.map((r) => r.id)).toEqual(['small', 'big']);
	});

	it('handles an empty store', () => {
		expect(selectMemoryTiers([], 4000, NOW)).toEqual({ hotIds: [], cold: [] });
	});
});

describe('selectMemoryTiers — the split must not move with the clock alone', () => {
	/**
	 * The memory block sits at the very front of the system prompt, so any change
	 * to which memories are inlined re-prefills the whole conversation upstream.
	 * The two decay terms have different half-lives (30d recall vs 7d freshness),
	 * so scores don't merely shrink over time — they CROSS, and a crossing near
	 * the budget cutoff silently swaps tier membership. CLAUDE.md's "payload is
	 * rent" rule allows the *user* to change the payload but forbids *timing*
	 * from doing so, hence day-quantized scoring.
	 *
	 * These rows are tuned to cross within a single day: `justSaved` leads on its
	 * fast-decaying freshness term at midnight and is overtaken before the day is
	 * out by `usedOnce`, whose recall term decays more slowly. Without
	 * quantization the hour-by-hour assertion below fails.
	 */
	// Anchored to the start of a real day bucket rather than to NOW, which sits
	// mid-bucket — otherwise "the same day" in these assertions wouldn't line up
	// with the day the quantizer actually rounds to.
	const DAY_START = Math.floor(NOW / DAY) * DAY + 1;
	const rows = [
		row({
			id: 'usedOnce',
			recallCount: 1,
			lastRecalledAt: DAY_START - 58 * DAY,
			createdAt: DAY_START - 200 * DAY,
			updatedAt: DAY_START - 200 * DAY,
			len: 100,
		}),
		row({
			id: 'justSaved',
			createdAt: DAY_START - 12.8 * DAY,
			updatedAt: DAY_START - 12.8 * DAY,
			len: 100,
		}),
	];
	// A second pair whose crossing falls BETWEEN two day buckets rather than
	// inside one — that's what makes the "still re-ranks" assertion real. The
	// pair above deliberately crosses *within* a bucket, which is what makes the
	// stability assertions non-vacuous; one pair can't do both.
	const slowRows = [
		row({
			id: 'usedOnce',
			recallCount: 1,
			lastRecalledAt: DAY_START - 58 * DAY,
			createdAt: DAY_START - 200 * DAY,
			updatedAt: DAY_START - 200 * DAY,
			len: 100,
		}),
		row({
			id: 'justSaved',
			createdAt: DAY_START - 12 * DAY,
			updatedAt: DAY_START - 12 * DAY,
			len: 100,
		}),
	];

	// Budget fits exactly one, so the ranking IS the observable output.
	const BUDGET = 150;

	it('is identical across every hour of the same day', () => {
		const base = selectMemoryTiers(rows, BUDGET, DAY_START);
		for (let hour = 1; hour < 24; hour++) {
			const t = DAY_START + hour * 60 * 60 * 1000;
			if (Math.ceil(t / DAY) !== Math.ceil(DAY_START / DAY)) break; // next bucket
			const later = selectMemoryTiers(rows, BUDGET, t);
			expect(later.hotIds, `tier split moved ${hour}h into the same day`).toEqual(base.hotIds);
			expect(later.cold.map((c) => c.id)).toEqual(base.cold.map((c) => c.id));
		}
	});

	it('is identical after a minute of idling, at any offset', () => {
		for (const offset of [0, 3 * DAY, 11 * DAY, 29 * DAY]) {
			const t = DAY_START + offset;
			const a = selectMemoryTiers(rows, BUDGET, t);
			const b = selectMemoryTiers(rows, BUDGET, t + 60_000);
			expect(b.hotIds, `split moved after 60s idling at +${offset / DAY}d`).toEqual(a.hotIds);
		}
	});

	it('still re-ranks as real days pass', () => {
		// Quantizing must not freeze the ranking outright — tiers should still
		// evolve, just not sub-daily.
		const early = selectMemoryTiers(slowRows, BUDGET, DAY_START);
		const later = selectMemoryTiers(slowRows, BUDGET, DAY_START + DAY);
		expect(early.hotIds).toEqual(['justSaved']);
		expect(later.hotIds).toEqual(['usedOnce']);
	});

	it('keeps a memory saved moments ago ahead of one saved earlier today', () => {
		// Guards the direction of the rounding. Flooring would put the reference
		// point before both, clamping each freshness delta to a tie and letting
		// the createdAt tiebreak inline the OLDER one.
		const sixHours = 6 * 60 * 60 * 1000;
		const earlier = row({
			id: 'earlier',
			createdAt: NOW - sixHours,
			updatedAt: NOW - sixHours,
			len: 100,
		});
		const newest = row({ id: 'newest', createdAt: NOW - 1000, updatedAt: NOW - 1000, len: 100 });
		const { hotIds } = selectMemoryTiers([earlier, newest], BUDGET, NOW);
		expect(hotIds).toEqual(['newest']);
	});
});
