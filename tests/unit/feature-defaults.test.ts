/**
 * Precedence for a new chat's feature opt-outs. Extracted from the new-chat
 * page's `$effect` specifically so it can be pinned here — the effect re-fires
 * on its own writes, and the ordering bug it can produce (a reused prompt's
 * toggles immediately overwritten by a default) is invisible until someone
 * reuses a prompt from a conversation where they'd changed one.
 */

import { describe, expect, it } from 'vitest';
import { seedDisabledFeatures } from '$lib/feature-defaults';

describe('seedDisabledFeatures', () => {
	it('starts from the user’s standing defaults', () => {
		expect(seedDisabledFeatures({ userDefaults: ['reactions'] })).toEqual(['reactions']);
	});

	it('starts empty when the user has set no defaults', () => {
		expect(seedDisabledFeatures({ userDefaults: [] })).toEqual([]);
	});

	it('unions a preset’s defaults with the user’s', () => {
		expect(
			seedDisabledFeatures({ userDefaults: ['reactions'], presetDefaults: ['web'] }).sort(),
		).toEqual(['reactions', 'web']);
	});

	it('does not let a preset re-enable what the user turned off globally', () => {
		// The point of union-not-replace: picking a roleplay preset that says
		// nothing about reactions must not undo "I never want emoji reactions".
		expect(seedDisabledFeatures({ userDefaults: ['reactions'], presetDefaults: [] })).toEqual([
			'reactions',
		]);
	});

	it('de-dupes an overlap between the two default sources', () => {
		expect(
			seedDisabledFeatures({ userDefaults: ['web'], presetDefaults: ['web', 'skills'] }),
		).toEqual(['web', 'skills']);
	});

	it('lets a reused prompt’s toggles win outright', () => {
		// Those are a choice already made in a real conversation, not a default —
		// including the choice to turn something back ON.
		expect(
			seedDisabledFeatures({
				userDefaults: ['reactions'],
				presetDefaults: ['web'],
				reusedFrom: [],
			}),
		).toEqual([]);
	});

	it('takes a reused prompt’s non-empty toggles verbatim', () => {
		expect(
			seedDisabledFeatures({
				userDefaults: ['reactions'],
				presetDefaults: ['web'],
				reusedFrom: ['skills'],
			}),
		).toEqual(['skills']);
	});

	it('falls through to the defaults when there is no reused prompt', () => {
		expect(seedDisabledFeatures({ userDefaults: ['reactions'], reusedFrom: null })).toEqual([
			'reactions',
		]);
	});

	it('never aliases an input array', () => {
		// The page reassigns the result wholesale; handing back `prefs`'s own
		// array would make a stale reference to it look like live state.
		const userDefaults = ['reactions'];
		const out = seedDisabledFeatures({ userDefaults });
		expect(out).not.toBe(userDefaults);
		const reusedFrom = ['web'];
		expect(seedDisabledFeatures({ userDefaults: [], reusedFrom })).not.toBe(reusedFrom);
	});
});
