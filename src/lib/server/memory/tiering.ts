/**
 * Memory tiering — the read-time scoring that decides, once a user's saved
 * memories exceed the inline budget, which get inlined in full (the "hot" tier)
 * vs. shown only as a `[id] topic` line (the "cold" tail). Pure: no DB, no clock
 * (callers pass `now`), so the ranking is deterministic and unit-testable.
 *
 * A memory's score blends two exponentially-decaying signals:
 *
 *   score = recall_count × decay(now − last_recalled_at)          // usage
 *         + FRESHNESS_WEIGHT × decay(now − max(created, updated))  // recency
 *
 * Recall usage keeps genuinely-referenced facts hot; the freshness term inlines
 * a just-saved memory immediately (it has no recall history yet) and lets it
 * fade if never used. Because decay is measured against `now` at read time, a
 * promoted memory — which, once inlined, stops being recalled — has its recall
 * term decay away and sinks back to the index on its own (self-erasing), rather
 * than a raw counter that would freeze it hot forever.
 */
import type { MemoryTierRow } from '../db/queries/memories';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Half-life of the recall-usage term: a hit counts full today, half ~a month
 *  later. Long, because a fact worth recalling stays relevant for a while. */
const RECALL_HALF_LIFE_MS = 30 * DAY_MS;

/** Half-life of the creation/edit freshness term — shorter than recall, so
 *  "new" fades faster than "used". */
const FRESHNESS_HALF_LIFE_MS = 7 * DAY_MS;

/** Weight of the freshness term relative to one just-now recall. 1 ⇒ a
 *  brand-new, never-recalled memory scores ≈ a memory recalled once right now,
 *  so fresh facts get inlined but a genuinely hot one (several recalls)
 *  outranks them. */
const FRESHNESS_WEIGHT = 1;

function decay(deltaMs: number, halfLifeMs: number): number {
	if (deltaMs <= 0) return 1;
	return 0.5 ** (deltaMs / halfLifeMs);
}

/** Blended recency-decayed score for one memory, as of `now` (epoch ms). */
export function scoreMemory(row: MemoryTierRow, now: number): number {
	const recallTerm =
		row.lastRecalledAt == null
			? 0
			: row.recallCount * decay(now - row.lastRecalledAt, RECALL_HALF_LIFE_MS);
	const freshTs = Math.max(row.createdAt, row.updatedAt);
	const freshnessTerm = FRESHNESS_WEIGHT * decay(now - freshTs, FRESHNESS_HALF_LIFE_MS);
	return recallTerm + freshnessTerm;
}

/**
 * Split memories into the hot (inline-in-full) and cold (topic-index) tiers.
 * Ranks by score desc (createdAt asc as a stable tiebreak), then greedy-prefix
 * fills the char budget by each row's body length `len`, stopping at the first
 * row that doesn't fit — it and the remainder are cold. Both tiers come back in
 * createdAt order so the rendered prompt is stable turn-to-turn even as tier
 * *membership* shifts slowly with the scores.
 */
export function selectMemoryTiers(
	rows: MemoryTierRow[],
	budgetChars: number,
	now: number,
): { hotIds: string[]; cold: MemoryTierRow[] } {
	const ranked = rows
		.map((row) => ({ row, score: scoreMemory(row, now) }))
		.sort((a, b) => b.score - a.score || a.row.createdAt - b.row.createdAt);

	const hot = new Set<string>();
	let used = 0;
	for (const { row } of ranked) {
		if (used + row.len > budgetChars) break;
		used += row.len;
		hot.add(row.id);
	}

	const byCreated = (a: MemoryTierRow, b: MemoryTierRow) => a.createdAt - b.createdAt;
	const hotIds = rows
		.filter((r) => hot.has(r.id))
		.sort(byCreated)
		.map((r) => r.id);
	const cold = rows.filter((r) => !hot.has(r.id)).sort(byCreated);
	return { hotIds, cold };
}
