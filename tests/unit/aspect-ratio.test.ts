/* @vitest-environment happy-dom */
/**
 * The composer's aspect-ratio logic: what to offer across a model selection,
 * and which offered shape a remembered preference resolves to.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	nearestOffered,
	offeredRatios,
	parseRatio,
	readStickyRatio,
	writeStickyRatio,
} from '$lib/aspect-ratio';
import type { AspectRatioOption, ModelEntry } from '$lib/types/api';

function model(id: string, aspectRatios?: AspectRatioOption[]): ModelEntry {
	return {
		id,
		endpointId: 'e',
		upstreamId: id,
		displayName: id,
		ownedBy: null,
		kind: 'image',
		kindKnown: true,
		group: 'g',
		groupKey: 'g',
		supportsTools: false,
		contextWindow: null,
		promptStyle: null,
		promptHint: null,
		...(aspectRatios ? { aspectRatios } : {}),
	};
}

const r = (...values: string[]): AspectRatioOption[] => values.map((value) => ({ value }));

describe('parseRatio', () => {
	it('reads W:H as a number', () => {
		expect(parseRatio('16:9')).toBeCloseTo(16 / 9);
		expect(parseRatio('1:1')).toBe(1);
		expect(parseRatio('9:16')).toBeCloseTo(9 / 16);
	});

	it.each(['', '16', '16-9', ':9', '16:', 'Square', '16:0', '0:9', 'a:b', '1.5:1'])(
		'rejects %j',
		(value) => {
			expect(parseRatio(value)).toBeNull();
		},
	);

	it('rejects a component too long to be a ratio', () => {
		// Unbounded, a 309-digit component overflows to Infinity and
		// `Infinity / Infinity` is NaN — which passes a falsy check and would reach
		// the glyph as a NaN-sized rect. Also keeps this in step with the bridge's
		// own `\d{1,6}` parser, so the two agree on what a ratio even is.
		const huge = '9'.repeat(320);
		expect(parseRatio(`${huge}:${huge}`)).toBeNull();
		expect(parseRatio('1234567:1')).toBeNull();
	});

	it('does not treat an unreduced conventional ratio as special', () => {
		// 21:9 must stay comparable without being renamed — the value is a token
		// echoed back to the upstream that offered it.
		expect(parseRatio('21:9')).toBeCloseTo(21 / 9);
	});
});

describe('offeredRatios', () => {
	it('is empty when nothing advertises any', () => {
		expect(offeredRatios([model('a'), model('b')])).toEqual([]);
	});

	it('keeps one model’s list in its declared order', () => {
		expect(offeredRatios([model('a', r('1:1', '16:9', '3:2'))]).map((o) => o.value)).toEqual([
			'1:1',
			'16:9',
			'3:2',
		]);
	});

	it('unions across models in first-seen order, deduped', () => {
		const offered = offeredRatios([model('a', r('1:1', '16:9')), model('b', r('16:9', '9:16'))]);
		expect(offered.map((o) => o.value)).toEqual(['1:1', '16:9', '9:16']);
	});

	it('takes the union rather than the intersection', () => {
		// The models overlap on nothing; an intersection would offer no shapes at
		// all for a comparison that both halves can serve.
		const offered = offeredRatios([model('a', r('16:9')), model('b', r('9:16'))]);
		expect(offered.map((o) => o.value)).toEqual(['16:9', '9:16']);
	});

	it('lets a model advertising none constrain nothing', () => {
		// It ignores whatever is sent, so it must not shrink the menu — otherwise
		// partial support would be more restrictive than no support.
		const offered = offeredRatios([model('a', r('16:9', '1:1')), model('b')]);
		expect(offered.map((o) => o.value)).toEqual(['16:9', '1:1']);
	});

	it('keeps the first label when two models describe the same ratio', () => {
		const offered = offeredRatios([
			model('a', [{ value: '16:9', label: 'Widescreen' }]),
			model('b', [{ value: '16:9', label: 'Cinema' }]),
		]);
		expect(offered).toEqual([{ value: '16:9', label: 'Widescreen' }]);
	});
});

describe('nearestOffered', () => {
	it('returns the exact option when the preference is on the menu', () => {
		expect(nearestOffered('16:9', r('1:1', '16:9'))?.value).toBe('16:9');
	});

	it('snaps a preference the menu lacks to the nearest shape', () => {
		// The point: switching to a model with a different menu must show what the
		// user will GET, not the preference being held.
		expect(nearestOffered('21:9', r('1:1', '3:2', '16:9'))?.value).toBe('16:9');
		expect(nearestOffered('9:16', r('1:1', '5:7', '16:9'))?.value).toBe('5:7');
	});

	it('measures distance in log space, so orientation is symmetric', () => {
		// 2:1 and 1:2 are equidistant from 1:1. A linear metric would make 2:1
		// (distance 1) look twice as far as 1:2 (distance 0.5) and always win.
		expect(nearestOffered('1:1', r('2:1', '1:2'))?.value).toBe('2:1');
		expect(nearestOffered('1:1', r('1:2', '2:1'))?.value).toBe('1:2');
	});

	it('breaks a tie by declared order, deterministically', () => {
		const options = r('2:1', '1:2');
		const picks = new Set(Array.from({ length: 20 }, () => nearestOffered('1:1', options)?.value));
		expect([...picks]).toEqual(['2:1']);
	});

	it('is null when there is nothing to offer or nothing to place', () => {
		expect(nearestOffered('16:9', [])).toBeNull();
		expect(nearestOffered(null, r('16:9'))).toBeNull();
		expect(nearestOffered('garbage', r('16:9'))).toBeNull();
	});

	it('ignores an unparseable option rather than choosing it', () => {
		expect(nearestOffered('16:9', [{ value: 'nonsense' }, { value: '3:2' }])?.value).toBe('3:2');
	});
});

describe('the remembered preference', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		localStorage.clear();
	});

	it('round-trips a pick', () => {
		writeStickyRatio('3:2');
		expect(readStickyRatio()).toBe('3:2');
	});

	it('is null when nothing was ever stored', () => {
		expect(readStickyRatio()).toBeNull();
	});

	it('lives under the prefix the sign-out wipe scans', () => {
		// `client-session-state.ts` clears everything under `glyphstream:` when a
		// session ends, because on a shared browser this state must not greet the
		// next person who signs in. A key outside that prefix silently opts out.
		writeStickyRatio('16:9');
		expect(localStorage.getItem('glyphstream:aspectRatio')).toBe('16:9');
		const keys = Object.keys(localStorage);
		expect(keys.every((k) => k.startsWith('glyphstream:'))).toBe(true);
	});

	it('adopts a preference stored under the pre-rename key, then removes it', () => {
		// Keeps an existing pick through the rename, and leaves no orphan sitting
		// permanently outside the wipe's reach.
		localStorage.setItem('gs:aspect-ratio', '3:2');
		expect(readStickyRatio()).toBe('3:2');
		expect(localStorage.getItem('gs:aspect-ratio')).toBeNull();
		expect(localStorage.getItem('glyphstream:aspectRatio')).toBe('3:2');
	});

	it('discards a junk value under the pre-rename key without adopting it', () => {
		localStorage.setItem('gs:aspect-ratio', 'widescreen');
		expect(readStickyRatio()).toBeNull();
		expect(localStorage.getItem('gs:aspect-ratio')).toBeNull();
		expect(localStorage.getItem('glyphstream:aspectRatio')).toBeNull();
	});

	it('prefers the current key when both are present', () => {
		localStorage.setItem('gs:aspect-ratio', '3:2');
		localStorage.setItem('glyphstream:aspectRatio', '16:9');
		expect(readStickyRatio()).toBe('16:9');
	});

	it('rejects a stored value that is no longer a ratio', () => {
		// Storage is shared with whatever else the origin has written and survives
		// deploys, so a junk value must read as "no preference".
		localStorage.setItem('gs:aspect-ratio', 'widescreen');
		expect(readStickyRatio()).toBeNull();
	});

	it('survives storage being unavailable', () => {
		// A private window or blocked site data makes the accessor itself throw;
		// the composer has to render correctly anyway.
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			},
		});
		expect(readStickyRatio()).toBeNull();
		expect(() => writeStickyRatio('16:9')).not.toThrow();
	});
});
