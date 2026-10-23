/**
 * `#lib/model-stats` — reading counters into rates, flags and page buckets.
 * The property that matters most: small samples can't raise a flag.
 */
import { describe, expect, it } from 'vitest';
import {
	bucketOf,
	chatSignals,
	daysOfData,
	isNewModel,
	flagsFor,
	formatRate,
	mediaSignals,
	wilsonLower,
} from '#lib/model-stats.js';
import type { ModelStatsModel } from '#lib/types/api.js';

function model(over: Partial<ModelStatsModel> = {}): ModelStatsModel {
	return {
		id: 'local::m',
		upstreamId: 'm',
		displayName: 'm',
		kind: 'chat',
		listed: true,
		roles: [],
		counts: {},
		sums: {},
		usedBy: 0,
		lastUsedAt: null,
		favoritedBy: 0,
		firstSeenDay: null,
		presets: [],
		...over,
	};
}

describe('wilsonLower', () => {
	it('is 0 with no trials and grows with evidence at the same rate', () => {
		expect(wilsonLower(0, 0)).toBe(0);
		const small = wilsonLower(3, 3);
		const large = wilsonLower(300, 300);
		expect(small).toBeLessThan(0.5);
		expect(large).toBeGreaterThan(0.98);
	});
});

describe('formatRate', () => {
	it('prints a fraction below the sample floor and a percent above it', () => {
		expect(formatRate({ k: 2, n: 3 })).toBe('2/3');
		expect(formatRate({ k: 5, n: 20 })).toBe('25%');
		expect(formatRate({ k: 1, n: 40 })).toBe('2.5%');
		expect(formatRate({ k: 0, n: 0 })).toBeNull();
	});
});

describe('flags', () => {
	it('does not flag a small sample, however extreme', () => {
		const m = model({ counts: { turn: 3, retry: 3 } });
		expect(flagsFor(m)).toEqual([]);
	});

	it('flags a well-evidenced retry rate', () => {
		const m = model({ counts: { turn: 100, retry: 50 } });
		expect(flagsFor(m).map((f) => f.label)).toEqual(['Often retried']);
	});

	it('has no losing-comparison flag, only a winning one', () => {
		const loser = model({ counts: { turn: 50, fanout_shown: 40, fanout_win: 0 } });
		expect(flagsFor(loser)).toEqual([]);
		const winner = model({ counts: { turn: 50, fanout_shown: 40, fanout_win: 36 } });
		expect(flagsFor(winner).map((f) => f.label)).toEqual(['Often picked']);
	});

	it('reads media favourites and deletions against what was generated', () => {
		const liked = model({
			kind: 'image',
			counts: { generated: 100, favorited: 40, unfavorited: 5 },
		});
		expect(flagsFor(liked).map((f) => f.label)).toEqual(['Well liked']);
		const disliked = model({ kind: 'image', counts: { generated: 100, trashed: 70, restored: 5 } });
		expect(flagsFor(disliked).map((f) => f.label)).toEqual(['Often deleted']);
	});

	it('marks a middling rejection rate as mixed, below the "often" flags', () => {
		const media = (trashed: number) => model({ kind: 'image', counts: { generated: 50, trashed } });
		expect(flagsFor(media(5))).toEqual([]);
		const mixed = flagsFor(media(15));
		expect(mixed.map((f) => [f.label, f.tone])).toEqual([['Mixed reception', 'mixed']]);
		expect(flagsFor(media(35)).map((f) => f.label)).toEqual(['Often deleted']);

		const chat = (retry: number) => model({ counts: { turn: 100, retry } });
		expect(flagsFor(chat(5))).toEqual([]);
		expect(flagsFor(chat(20)).map((f) => f.label)).toEqual(['Mixed reception']);
		expect(flagsFor(chat(50)).map((f) => f.label)).toEqual(['Often retried']);
	});
});

describe('signals', () => {
	it('chat: errors are out of attempts, speed from timed turns only', () => {
		const sig = chatSignals(
			model({ counts: { turn: 9, error: 1 }, sums: { speed_tokens: 500, speed_ms: 10_000 } }),
		);
		expect(sig.errors).toEqual({ k: 1, n: 10 });
		expect(sig.tokensPerSecond).toBe(50);
	});

	it('media: restores net against trashes, and swept outputs are not rejections', () => {
		const sig = mediaSignals(
			model({ kind: 'image', counts: { generated: 10, trashed: 4, restored: 1, swept: 5 } }),
		);
		expect(sig.rejected).toEqual({ k: 3, n: 10 });
	});
});

describe('volume-neutral signals', () => {
	// A model in use for months racks up more of everything than one installed
	// last week; reading a count as a verdict would penalise the long-kept one.
	it('reads "built on" and "switched away" as shares, not running totals', () => {
		const old = mediaSignals(
			model({ kind: 'image', counts: { generated: 1000, remixed: 90, avatar_set: 10 } }),
		);
		const fresh = mediaSignals(model({ kind: 'image', counts: { generated: 10, remixed: 5 } }));
		expect(old.used).toEqual({ k: 100, n: 1000 });
		expect(fresh.used).toEqual({ k: 5, n: 10 });

		const chat = chatSignals(model({ counts: { turn: 200, switched_away: 10 } }));
		expect(chat.switchedAway).toEqual({ k: 10, n: 200 });
	});

	it('caps "built on" at the outputs when one is used more than once', () => {
		const sig = mediaSignals(model({ kind: 'image', counts: { generated: 2, remixed: 5 } }));
		expect(sig.used).toEqual({ k: 2, n: 2 });
	});
});

describe('new models', () => {
	const NOW = Date.UTC(2026, 9, 18, 12);

	it('counts days of data from the first counted day, inclusive', () => {
		expect(daysOfData(model({ firstSeenDay: '2026-10-18' }), NOW)).toBe(1);
		expect(daysOfData(model({ firstSeenDay: '2026-10-16' }), NOW)).toBe(3);
		expect(daysOfData(model(), NOW)).toBeNull();
	});

	it('calls a model new for its first two weeks only', () => {
		expect(isNewModel(model({ firstSeenDay: '2026-10-05' }), NOW)).toBe(true);
		expect(isNewModel(model({ firstSeenDay: '2026-10-04' }), NOW)).toBe(false);
		expect(isNewModel(model(), NOW)).toBe(false);
	});
});

describe('bucketOf', () => {
	it('sorts a model into active, unused or retired', () => {
		expect(bucketOf(model({ counts: { turn: 1 } }))).toBe('active');
		expect(bucketOf(model())).toBe('unused');
		expect(bucketOf(model({ listed: false }))).toBe('retired');
	});

	it('never calls a model with a configured job unused', () => {
		expect(bucketOf(model({ roles: ['embeddings'], kind: 'embedding' }))).toBe('active');
		expect(bucketOf(model({ counts: { 'task:title': 4 } }))).toBe('active');
	});

	it('counts a model used only through a preset as active', () => {
		expect(bucketOf(model({ presets: [{ id: 'p', name: 'P', exists: true, chats: 2 }] }))).toBe(
			'active',
		);
	});
});
