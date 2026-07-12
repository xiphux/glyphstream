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
	it('round-trips every writable field (add a preference → add it here)', async () => {
		// The general guard. The allowlist is hand-maintained with no spread, so a
		// new field is silently dropped until someone remembers this file. Anything
		// absent from the forwarded patch below is a field the API cannot save.
		const full: Partial<UserPreferences> = {
			name: 'Chris',
			aboutYou: 'engineer',
			customInstructions: 'be brief',
			enterBehavior: 'newline',
			showGreeting: false,
			theme: 'claude',
			colorScheme: 'dark',
			notificationsEnabled: true,
			notificationsShowContent: true,
			notificationsForegroundToast: false,
			favoriteModels: ['e::m'],
			modelSets: [],
			trustedMcpTools: [],
			autoCompactionEnabled: false,
			autoCompactionThreshold: 60,
			timezone: 'Europe/London',
		};

		const forwarded = await patch(full);

		for (const key of Object.keys(full) as (keyof UserPreferences)[]) {
			// trustedMcpTools is managed by the approval flow, not this route.
			if (key === 'trustedMcpTools') continue;
			expect(forwarded, `"${key}" is not in the PATCH allowlist`).toHaveProperty(key);
		}
	});

	it('drops unknown fields instead of writing them through', async () => {
		expect(await patch({ isAdmin: true, preferencesJson: 'pwned' })).toEqual({});
	});
});
