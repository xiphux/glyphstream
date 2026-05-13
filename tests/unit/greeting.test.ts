import { describe, expect, it } from 'vitest';
import { firstName, preferredFirstName, timeOfDayGreeting } from '$lib/greeting';

describe('firstName', () => {
	it('takes the first whitespace-separated token of displayName', () => {
		expect(firstName('Christopher Han', 'xiphux')).toBe('Christopher');
	});

	it('handles single-name displayName', () => {
		expect(firstName('Madonna', 'mad')).toBe('Madonna');
	});

	it('falls back to githubUsername when displayName is null', () => {
		expect(firstName(null, 'xiphux')).toBe('xiphux');
	});

	it('falls back when displayName is whitespace-only', () => {
		// .trim().split() on '   ' yields [''] — first token is empty,
		// falls through to fallback.
		expect(firstName('   ', 'xiphux')).toBe('xiphux');
	});

	it('handles multiple whitespace between names', () => {
		expect(firstName('Mary  Jane Watson', 'mj')).toBe('Mary');
	});
});

describe('preferredFirstName', () => {
	it('prefers the explicit preference name over GitHub-derived values', () => {
		// User picked "Chris" in Preferences ▸ Name — that wins even when
		// the GitHub display name says something else.
		expect(preferredFirstName('Chris', 'Christopher Han', 'xiphux')).toBe('Chris');
	});

	it('uses the preference name verbatim (no first-name extraction)', () => {
		// Whatever the user typed is their choice — "Mr. Smith" stays
		// "Mr. Smith," not "Mr.". Preference name = exactly the address
		// the user wants used, not a "name field to be parsed."
		expect(preferredFirstName('Mr. Smith', 'Bob Jones', 'bob')).toBe('Mr. Smith');
	});

	it('falls through to firstName(displayName, fallback) when preference is empty', () => {
		expect(preferredFirstName('', 'Christopher Han', 'xiphux')).toBe('Christopher');
		expect(preferredFirstName(null, 'Christopher Han', 'xiphux')).toBe('Christopher');
		expect(preferredFirstName(undefined, 'Christopher Han', 'xiphux')).toBe('Christopher');
	});

	it('treats whitespace-only preference as empty', () => {
		expect(preferredFirstName('   ', 'Christopher Han', 'xiphux')).toBe('Christopher');
	});

	it('falls through all the way to the fallback when nothing is set', () => {
		expect(preferredFirstName('', null, 'xiphux')).toBe('xiphux');
		expect(preferredFirstName(null, null, 'xiphux')).toBe('xiphux');
	});

	it('trims surrounding whitespace from the preference but keeps internal spacing', () => {
		expect(preferredFirstName('  Chris H  ', 'Christopher Han', 'xiphux')).toBe('Chris H');
	});
});

describe('timeOfDayGreeting', () => {
	function at(hour: number) {
		const d = new Date(2026, 0, 1, hour, 30);
		return timeOfDayGreeting(d);
	}

	// Variation slots — picked deterministically from per-day hash. Tests
	// assert slot-membership rather than exact strings so the variation
	// mechanism itself is what's covered, not just one (date, hour) point.
	const MORNING_VARIATIONS = ['Good morning', 'Top of the morning', 'Morning'];
	const AFTERNOON_VARIATIONS = [
		'Good afternoon',
		'Afternoon',
		"Hope your day's going well"
	];
	const EVENING_VARIATIONS = ['Good evening', 'Evening', 'Hope your day went well'];

	it('returns "Still up" before 5am (singleton — no variations)', () => {
		expect(at(0)).toBe('Still up');
		expect(at(4)).toBe('Still up');
	});

	it('returns a morning variation 5am-noon', () => {
		expect(MORNING_VARIATIONS).toContain(at(5));
		expect(MORNING_VARIATIONS).toContain(at(11));
	});

	it('returns an afternoon variation noon-5pm', () => {
		expect(AFTERNOON_VARIATIONS).toContain(at(12));
		expect(AFTERNOON_VARIATIONS).toContain(at(16));
	});

	it('returns an evening variation 5pm-10pm', () => {
		expect(EVENING_VARIATIONS).toContain(at(17));
		expect(EVENING_VARIATIONS).toContain(at(21));
	});

	it('returns "Burning the midnight oil" after 10pm (singleton — no variations)', () => {
		expect(at(22)).toBe('Burning the midnight oil');
		expect(at(23)).toBe('Burning the midnight oil');
	});

	it('is stable within a calendar day — same day, different hours in slot → same greeting', () => {
		// At 6am and 11am on the same day, the morning variation must
		// match — refreshing the page in the morning shouldn't churn.
		const morningEarly = timeOfDayGreeting(new Date(2026, 4, 12, 6, 0));
		const morningLate = timeOfDayGreeting(new Date(2026, 4, 12, 11, 0));
		expect(morningEarly).toBe(morningLate);
	});

	it('can vary across days within the same slot', () => {
		// Sweep a year of morning visits at 8am. Variation indices are
		// dayHash % 3, so we should see all 3 morning variations.
		const seen = new Set<string>();
		for (let day = 1; day <= 31; day++) {
			seen.add(timeOfDayGreeting(new Date(2026, 0, day, 8, 0)));
		}
		// All three morning variations must appear across a month.
		for (const v of MORNING_VARIATIONS) expect(seen.has(v)).toBe(true);
	});
});
