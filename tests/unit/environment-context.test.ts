/**
 * The environment preamble — the one line that tells the model what day it is.
 *
 * The property that matters most isn't the wording, it's that the block is
 * STABLE ACROSS A DAY. It sits at the front of the prefix, so anything in it that
 * varies between two turns invalidates the upstream's KV/prefix cache for the
 * entire conversation. A clock would do that on every single turn.
 */

import { describe, expect, it } from 'vitest';
import { composeEnvironmentBlock } from '$lib/server/chat/environment-context';

describe('composeEnvironmentBlock', () => {
	it('names the current date', () => {
		const block = composeEnvironmentBlock(new Date('2026-07-11T12:00:00Z'));
		expect(block).toContain('2026');
		expect(block).toMatch(/July|Jul/);
	});

	it('names the timezone it rendered in, rather than leaving UTC to be assumed', () => {
		// A bare date is wrong by up to a day for anyone west of Greenwich — exactly
		// the off-by-one this block exists to prevent.
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		expect(composeEnvironmentBlock(new Date())).toContain(tz);
	});

	it("renders the date in the USER's timezone, not the server's", () => {
		// 01:30 UTC is still the previous day in Chicago. The whole point of carrying
		// the user's zone is that this reads "January 14", not "January 15".
		const instant = new Date('2026-01-15T01:30:00Z');
		const chicago = composeEnvironmentBlock(instant, 'America/Chicago');
		const tokyo = composeEnvironmentBlock(instant, 'Asia/Tokyo');

		expect(chicago).toContain('January 14, 2026');
		expect(chicago).toContain('America/Chicago');
		// Same instant, and it is already the 15th in Tokyo.
		expect(tokyo).toContain('January 15, 2026');
		expect(tokyo).toContain('Asia/Tokyo');
	});

	it('falls back to the server zone when the user has no stored timezone', () => {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		expect(composeEnvironmentBlock(new Date(), null)).toContain(tz);
	});

	it('falls back rather than throwing on a zone Intl no longer recognizes', () => {
		// A zone persisted by an older build, or retired by an ICU update, would make
		// Intl throw — on the send path, where the blast radius is "this user can't
		// chat at all".
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		expect(composeEnvironmentBlock(new Date(), 'Mars/Olympus_Mons')).toContain(tz);
	});

	it('is identical for two different times on the same day', () => {
		// THE cache-critical property. Two turns seconds apart must produce
		// byte-identical bytes, or the whole conversation re-prefills every turn.
		const morning = composeEnvironmentBlock(new Date('2026-07-11T08:15:30Z'));
		const evening = composeEnvironmentBlock(new Date('2026-07-11T08:47:59Z'));
		expect(morning).toBe(evening);
	});

	it('carries no time of day', () => {
		const block = composeEnvironmentBlock(new Date('2026-07-11T13:45:07Z'));
		// A clock in the system prompt would change the prefix on every request.
		expect(block).not.toMatch(/\d{1,2}:\d{2}/);
	});

	it('changes when the day changes', () => {
		const a = composeEnvironmentBlock(new Date('2026-07-11T12:00:00Z'));
		const b = composeEnvironmentBlock(new Date('2026-07-12T12:00:00Z'));
		expect(a).not.toBe(b);
	});

	it('points the model at get_current_time for what it does not cover', () => {
		expect(composeEnvironmentBlock(new Date())).toContain('get_current_time');
	});

	it('stays small — it is paid on every turn of every conversation', () => {
		expect(composeEnvironmentBlock(new Date()).length).toBeLessThan(220);
	});
});
