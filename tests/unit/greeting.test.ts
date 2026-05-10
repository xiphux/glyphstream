import { describe, expect, it } from 'vitest';
import { firstName, timeOfDayGreeting } from '$lib/greeting';

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

describe('timeOfDayGreeting', () => {
	function at(hour: number) {
		const d = new Date(2026, 0, 1, hour, 30);
		return timeOfDayGreeting(d);
	}

	it('returns "Still up" before 5am', () => {
		expect(at(0)).toBe('Still up');
		expect(at(4)).toBe('Still up');
	});

	it('returns "Good morning" 5am-noon', () => {
		expect(at(5)).toBe('Good morning');
		expect(at(11)).toBe('Good morning');
	});

	it('returns "Good afternoon" noon-5pm', () => {
		expect(at(12)).toBe('Good afternoon');
		expect(at(16)).toBe('Good afternoon');
	});

	it('returns "Good evening" 5pm-10pm', () => {
		expect(at(17)).toBe('Good evening');
		expect(at(21)).toBe('Good evening');
	});

	it('returns "Burning the midnight oil" after 10pm', () => {
		expect(at(22)).toBe('Burning the midnight oil');
		expect(at(23)).toBe('Burning the midnight oil');
	});
});
