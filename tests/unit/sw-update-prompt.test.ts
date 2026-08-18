/**
 * The rule deciding whether a waiting worker earns the update banner.
 *
 * Both directions matter, and they fail in opposite ways. Prompt too eagerly
 * and the banner appears on the first launch after every deploy offering a
 * refresh onto the build already on screen — observed in production, and the
 * fastest way to teach someone to dismiss it on sight. Prompt too reluctantly
 * and someone sits on stale client code against a new server with nothing to
 * tell them, which is the exact failure this app already shipped once when the
 * worker came out byte-identical between releases.
 */
import { describe, expect, it } from 'vitest';
import { shouldPromptForUpdate } from '$lib/sw/update-prompt';

describe('shouldPromptForUpdate', () => {
	it('stays quiet when the waiting worker is the build already running', () => {
		// The cold-launch-after-deploy case: the page was fetched fresh from the
		// server and is already current; the worker is just catching up.
		expect(shouldPromptForUpdate('0.34.5', '0.34.5')).toBe(false);
	});

	it('prompts when the waiting worker is a different build', () => {
		// The deploy-landed-mid-session case, and the only one where the user
		// genuinely is running old code.
		expect(shouldPromptForUpdate('0.34.5', '0.34.6')).toBe(true);
	});

	it('prompts when the worker never answers', () => {
		// A worker predating GET_BUILD, or one that failed to boot. Failing open
		// costs at most one redundant banner; failing closed hides a real update
		// behind a silent timeout.
		expect(shouldPromptForUpdate('0.34.5', null)).toBe(true);
	});

	it('prompts on a downgrade, not just an increase', () => {
		// A rollback still leaves the page and the worker disagreeing, and the
		// user still wants off the build that is no longer being served. The
		// rule is deliberately "different", not "greater".
		expect(shouldPromptForUpdate('0.34.6', '0.34.5')).toBe(true);
	});
});
