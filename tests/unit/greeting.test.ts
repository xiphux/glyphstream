import { describe, expect, it } from 'vitest';
import {
	AFTERNOON,
	ANYTIME,
	composeGreeting,
	EARLY,
	EASTER_EGGS,
	EVENING,
	firstName,
	greetingContextKey,
	MORNING,
	NIGHT,
	pickGreeting,
	preferredFirstName,
} from '$lib/greeting';

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

describe('composeGreeting', () => {
	it('fills the {name} token with the user name', () => {
		expect(composeGreeting('Welcome back, {name}', 'Chris')).toBe('Welcome back, Chris');
	});

	it('places the token wherever the template puts it (mid-sentence)', () => {
		expect(composeGreeting("Well, well, well, if it isn't {name}", 'Chris')).toBe(
			"Well, well, well, if it isn't Chris",
		);
	});

	it('replaces every occurrence of the token', () => {
		expect(composeGreeting('{name}, oh {name}', 'Chris')).toBe('Chris, oh Chris');
	});

	it('leaves name-free templates untouched', () => {
		expect(composeGreeting('Ask me anything', 'Chris')).toBe('Ask me anything');
	});
});

describe('pickGreeting', () => {
	// `rand` is injectable so picks are deterministic in tests. A constant
	// returns the same value every call; `seq` plays back a fixed sequence
	// (first value gates the daytime easter egg, the next indexes the pool).
	const constant = (v: number) => () => v;
	function seq(...vals: number[]) {
		let i = 0;
		return () => vals[Math.min(i++, vals.length - 1)];
	}
	// Deterministic PRNG (mulberry32) for variety sweeps — reproducible across
	// runs, unlike Math.random.
	function prng(seed: number) {
		return () => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	// A plain mid-month, non-holiday date for the ordinary slot assertions.
	function on(month: number, day: number, hour: number, rand: () => number) {
		return pickGreeting(new Date(2026, month, day, hour, 30), rand).greeting;
	}
	// Pull the egg gate closed (first rand >= EGG_CHANCE), then index 0.
	const noEgg = () => seq(0.99, 0);

	it('returns a wee-hours line before 5am', () => {
		expect(EARLY).toContain(on(4, 12, 0, constant(0)));
		expect(EARLY).toContain(on(4, 12, 4, constant(0.99)));
	});

	it('returns a morning line 5am-noon (egg gate closed)', () => {
		expect([...MORNING, ...ANYTIME]).toContain(on(4, 12, 5, noEgg()));
		expect([...MORNING, ...ANYTIME]).toContain(on(4, 12, 11, noEgg()));
	});

	it('returns an afternoon line noon-5pm (egg gate closed)', () => {
		expect([...AFTERNOON, ...ANYTIME]).toContain(on(4, 12, 12, noEgg()));
		expect([...AFTERNOON, ...ANYTIME]).toContain(on(4, 12, 16, noEgg()));
	});

	it('returns an evening line 5pm-10pm (egg gate closed)', () => {
		expect([...EVENING, ...ANYTIME]).toContain(on(4, 12, 17, noEgg()));
		expect([...EVENING, ...ANYTIME]).toContain(on(4, 12, 21, noEgg()));
	});

	it('returns a late-night line after 10pm', () => {
		expect(NIGHT).toContain(on(4, 12, 22, constant(0)));
		expect(NIGHT).toContain(on(4, 12, 23, constant(0.99)));
	});

	it('surfaces an easter egg when the daytime gate opens', () => {
		// First rand below EGG_CHANCE opens the gate; the next indexes the egg.
		expect(EASTER_EGGS).toContain(on(4, 12, 10, seq(0, 0)));
	});

	it('rolls a different line as randomness varies (not stuck)', () => {
		// Same moment, many rolls — the blended pool should yield real variety.
		const rand = prng(1);
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			seen.add(pickGreeting(new Date(2026, 5, 12, 8, 0), rand).greeting);
		}
		expect(seen.size).toBeGreaterThanOrEqual(8);
	});

	it('holiday lines win over the ordinary slot and ignore randomness', () => {
		// New Year's morning greets with the holiday no matter what rand does.
		expect(pickGreeting(new Date(2026, 0, 1, 9, 0), constant(0)).greeting).toBe(
			'Happy New Year, {name}',
		);
		// Friday the 13th (2026-02-13 is a Friday) fires regardless of hour.
		expect(pickGreeting(new Date(2026, 1, 13, 14, 0), constant(0)).greeting).toBe(
			'Watch your step, {name}',
		);
	});

	it('marks the nerd holidays on their dates', () => {
		const g = (y: number, m: number, d: number) =>
			pickGreeting(new Date(y, m, d, 10, 0), constant(0)).greeting;
		expect(g(2026, 4, 4)).toBe('May the 4th be with you, {name}');
		expect(g(2026, 4, 25)).toBe("Don't panic, {name}");
		expect(g(2026, 10, 23)).toBe('Happy Fibonacci Day, {name}');
		expect(g(2026, 2, 31)).toBe('Backed up lately, {name}?');
		// Programmers' Day = 256th day: Sep 13 in common years, Sep 12 in leap.
		expect(g(2026, 8, 13)).toBe("Happy Programmers' Day, {name}");
		expect(g(2028, 8, 12)).toBe("Happy Programmers' Day, {name}");
	});
});

describe('greetingContextKey', () => {
	it('is stable within the same day + slot — refocus should leave it alone', () => {
		// 6am and 11am on the same day share the morning slot.
		const a = greetingContextKey(new Date(2026, 4, 12, 6, 0));
		const b = greetingContextKey(new Date(2026, 4, 12, 11, 0));
		expect(a).toBe(b);
	});

	it('changes when the time-of-day slot changes — refocus should re-roll', () => {
		const evening = greetingContextKey(new Date(2026, 4, 12, 20, 0));
		const night = greetingContextKey(new Date(2026, 4, 12, 23, 0));
		expect(evening).not.toBe(night);
	});

	it('changes across days even within the same slot', () => {
		const today = greetingContextKey(new Date(2026, 4, 12, 8, 0));
		const tomorrow = greetingContextKey(new Date(2026, 4, 13, 8, 0));
		expect(today).not.toBe(tomorrow);
	});

	it('keys off the holiday on holidays, so it holds all day', () => {
		const morning = greetingContextKey(new Date(2026, 0, 1, 9, 0));
		const evening = greetingContextKey(new Date(2026, 0, 1, 20, 0));
		expect(morning).toBe(evening);
		expect(morning).toContain('Happy New Year');
	});
});
