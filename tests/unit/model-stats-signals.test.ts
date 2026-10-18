/**
 * `#lib/model-stats` — reading counters into rates, flags and page buckets.
 * The property that matters most: small samples can't raise a flag.
 */
import { describe, expect, it } from 'vitest';
import {
	bucketOf,
	chatSignals,
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
