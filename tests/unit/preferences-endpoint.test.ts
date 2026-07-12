/**
 * Route-handler tests for PATCH /api/user/preferences.
 *
 * The handler builds its patch from a hand-maintained, field-by-field allowlist
 * — no spread, no schema parse. That's a deliberate defense-in-depth choice, and
 * it has one failure mode: a field added to `UserPreferences`, to `DEFAULTS`, and
 * to `coerceUserPreferences` but NOT to this allowlist is silently dropped. The
 * route still answers 200, so the client believes it saved.
 *
 * That is exactly what happened to `timezone`: the whole feature was inert, and
 * because the client re-syncs whenever the stored value differs from the browser's,
 * it also meant a pointless PATCH on every single app load, forever.
 *
 * `user-preferences.test.ts` couldn't catch it — it calls `setUserPreferences`
 * directly, downstream of the allowlist. So the assertion has to live here, at
 * the seam. The `round-trips every writable field` test below is the general
 * guard: add a preference, add it here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserPreferences } from '$lib/types/api';

const mocks = vi.hoisted(() => ({
	setUserPreferences: vi.fn<(...a: unknown[]) => unknown>(),
}));

vi.mock('$lib/server/auth/guard', () => ({ requireUser: () => {} }));
vi.mock('$lib/server/db/queries/user-preferences', () => ({
	getUserPreferences: () => ({ theme: 'glyphstream' }),
	setUserPreferences: (...a: unknown[]) => mocks.setUserPreferences(...a),
}));

import { PATCH } from '../../src/routes/api/user/preferences/+server';

/** The patch object the handler actually forwarded to the query layer. */
function forwardedPatch(): Partial<UserPreferences> {
	return mocks.setUserPreferences.mock.calls[0][1] as Partial<UserPreferences>;
}

async function patch(body: unknown) {
	const cookies = { set: () => {} };
	await PATCH({
		locals: { user: { id: 'u1' } },
		request: new Request('http://x/api/user/preferences', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
		cookies,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
	return forwardedPatch();
}

beforeEach(() => {
	mocks.setUserPreferences.mockReset();
	mocks.setUserPreferences.mockReturnValue({ theme: 'glyphstream' });
});

describe('PATCH /api/user/preferences — timezone', () => {
	it('forwards a browser-reported IANA zone to the query layer', async () => {
		// The bug: `timezone` was absent from the allowlist, so this arrived as {}.
		// The route answered 200, the client reported success, and the value was
		// never stored — leaving the model reading the SERVER's date forever, which
		// is the precise failure the timezone feature exists to prevent.
		expect(await patch({ timezone: 'America/Chicago' })).toEqual({
			timezone: 'America/Chicago',
		});
	});

	it('forwards an explicit null so the zone can be cleared', async () => {
		expect(await patch({ timezone: null })).toEqual({ timezone: null });
	});

	it('ignores a non-string, non-null timezone rather than forwarding junk', async () => {
		expect(await patch({ timezone: 42 })).toEqual({});
	});

	it('leaves IANA validation to the query layer (which Intl-checks it)', async () => {
		// Deliberately forwarded, NOT 400'd: `coerceTimezone` resolves it through
		// Intl and keeps the previous value if it doesn't exist. Rejecting here would
		// also be defensible, but this is a background sync the user never asked for.
		expect(await patch({ timezone: 'Mars/Olympus_Mons' })).toEqual({
			timezone: 'Mars/Olympus_Mons',
		});
	});
});

describe('PATCH /api/user/preferences — the allowlist', () => {
	/**
	 * Typed as the full `UserPreferences` (not Partial), so adding a field to the
	 * interface fails `pnpm check` right here until someone lists it — otherwise the
	 * fixture drifts silently in exactly the same way the hand-maintained allowlist
	 * it exists to guard did, and the test keeps passing while the new field is
	 * quietly dropped by the route.
	 *
	 * THREE passes, and the count is pigeonhole arithmetic rather than taste. To
	 * catch a cross-wire (`patch.a = body.b`) by comparing values, every field must
	 * carry a value sequence no other field shares. A boolean's sequence over N
	 * passes is an N-bit word, so N passes distinguish at most 2^N booleans — and
	 * there are five. Two passes admit only four signatures and in practice gave
	 * each boolean one of two (TF or FT), which is why an earlier version of this
	 * fixture claimed to catch any aliasing pair and demonstrably did not:
	 * `patch.notificationsEnabled = body.showGreeting` sailed straight through it.
	 *
	 * Three passes give eight signatures; the five booleans below take five distinct
	 * ones. Every other field is likewise distinct per pass — including `modelSets`,
	 * which must be NON-EMPTY or it silently aliases the (also empty)
	 * `trustedMcpTools`.
	 */
	const PASSES = [0, 1, 2] as const;
	/** Unique 3-bit signature per boolean — see the pigeonhole note above. */
	const bits = {
		showGreeting: [true, true, false],
		notificationsEnabled: [true, false, true],
		notificationsShowContent: [true, false, false],
		notificationsForegroundToast: [false, true, true],
		autoCompactionEnabled: [false, true, false],
	} as const;

	function fixture(p: 0 | 1 | 2): UserPreferences {
		return {
			name: ['Chris', 'Alex', 'Sam'][p],
			aboutYou: ['engineer', 'teacher', 'chef'][p],
			customInstructions: ['be brief', 'be thorough', 'be funny'][p],
			enterBehavior: (['newline', 'send', 'newline'] as const)[p],
			showGreeting: bits.showGreeting[p],
			theme: (['claude', 'chatgpt', 'glyphstream'] as const)[p],
			colorScheme: (['dark', 'light', 'system'] as const)[p],
			notificationsEnabled: bits.notificationsEnabled[p],
			notificationsShowContent: bits.notificationsShowContent[p],
			notificationsForegroundToast: bits.notificationsForegroundToast[p],
			favoriteModels: [['e::a'], ['e::b'], ['e::c']][p],
			modelSets: [
				{ id: `set-${p}`, name: `Set ${p}`, models: [{ modelId: `e::m${p}`, count: p + 1 }] },
			],
			// Distinct and NON-EMPTY even though this field isn't writable here. It's
			// still a `body.*` key the route could accidentally read from, and if it
			// stayed `[]` then any future field that also defaults to `[]` could be wired
			// to it and round-trip green. Giving it a signature makes that cross-wire
			// fail like any other.
			trustedMcpTools: [[`mcp__a__t${p}`], [`mcp__b__t${p}`], [`mcp__c__t${p}`]][p],
			autoCompactionEnabled: bits.autoCompactionEnabled[p],
			autoCompactionThreshold: [60, 95, 30][p],
			timezone: ['Europe/London', 'Asia/Tokyo', 'America/Chicago'][p],
		};
	}

	it('gives every field a signature no other field shares', () => {
		// Guards the guard: if a future edit makes two fields carry identical values
		// across all three passes, a cross-wire between them becomes undetectable and
		// the suite would go quietly blind rather than fail.
		//
		// EVERY key, including `trustedMcpTools`. It isn't writable through this route,
		// but it's still a `body.*` key the handler could accidentally read from — so it
		// needs a distinct signature like any other, or a future field wired to it would
		// round-trip green.
		const signatures = new Map<string, string>();
		for (const key of Object.keys(fixture(0)) as (keyof UserPreferences)[]) {
			const sig = JSON.stringify(PASSES.map((p) => fixture(p)[key]));
			const clash = [...signatures.entries()].find(([, s]) => s === sig);
			expect(clash?.[0], `"${key}" is indistinguishable from "${clash?.[0]}"`).toBeUndefined();
			signatures.set(key, sig);
		}
	});

	it.each(PASSES)(
		'round-trips every writable field, pass %i (add a preference → add it here)',
		async (p) => {
			const full = fixture(p);
			const forwarded = await patch(full);

			// Compare VALUES, not just key presence: a field wired to the wrong `body.*`
			// key would still be "present" while carrying the wrong data.
			// `trustedMcpTools` is managed by the tool-approval flow, not this route — the
			// single deliberate exclusion, and spelled out rather than skipped in a loop.
			const { trustedMcpTools: _excluded, ...writable } = full;
			expect(forwarded).toEqual(writable);
		},
	);

	it('drops unknown fields instead of writing them through', async () => {
		expect(await patch({ isAdmin: true, preferencesJson: 'pwned' })).toEqual({});
	});
});
