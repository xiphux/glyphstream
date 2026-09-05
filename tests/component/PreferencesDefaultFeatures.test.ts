/* @vitest-environment happy-dom */

/**
 * Component test for the "Default features" section of the preferences page.
 *
 * Three behaviours here live entirely in async ordering around a fetch, which a
 * node-env unit test cannot see (Svelte resolves to the SSR runtime there, so
 * handlers never run) and `pnpm check` cannot see either. All three were bugs
 * found in review rather than written correctly first time:
 *
 *  - a failed save used to leave the checkbox showing a value the server never
 *    stored, and the NEXT toggle computed its array from that diverged state —
 *    so the change the user was told had failed rode along and got persisted;
 *  - the save didn't re-run the layout load, so turning a feature off by default
 *    and immediately starting a chat still got the old value;
 *  - and when that was fixed, it re-ran the layout load after EVERY preference
 *    on the page, including text fields on blur.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { FeatureCategoryEntry, UserPreferences } from '$lib/types/api';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

const mocks = vi.hoisted(() => ({
	invalidate: vi.fn<(key: string) => Promise<void>>(async () => {}),
}));
vi.mock('$app/navigation', () => ({
	invalidate: (key: string) => mocks.invalidate(key),
	invalidateAll: vi.fn(async () => {}),
	goto: vi.fn(async () => {}),
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
}));

import PreferencesPage from '../../src/routes/(app)/settings/preferences/+page.svelte';

const CATEGORIES: FeatureCategoryEntry[] = [
	{ id: 'web', label: 'Web access', description: 'Search and fetch.', source: 'builtin' },
	{ id: 'reactions', label: 'Emoji reactions', description: 'Tap an emoji.', source: 'builtin' },
];

function prefs(over: Partial<UserPreferences> = {}): UserPreferences {
	return {
		name: '',
		aboutYou: '',
		customInstructions: '',
		enterBehavior: 'send',
		showGreeting: true,
		theme: 'glyphstream',
		colorScheme: 'system',
		notificationsEnabled: false,
		notificationsShowContent: false,
		notificationsForegroundToast: true,
		favoriteModels: [],
		avatarModelId: null,
		modelSets: [],
		trustedMcpTools: [],
		autoCompactionEnabled: true,
		autoCompactionThreshold: 80,
		timezone: null,
		defaultDisabledFeatures: [],
		...over,
	};
}

/** Answer the PATCH with `body` (echoing the patch onto the base prefs), or fail. */
function stubFetch(ok: boolean, echo: (patch: Partial<UserPreferences>) => UserPreferences) {
	const seen: Array<Partial<UserPreferences>> = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: string }) => {
			const patch = JSON.parse(init.body) as Partial<UserPreferences>;
			seen.push(patch);
			return {
				ok,
				json: async () => echo(patch),
			} as unknown as Response;
		}),
	);
	return seen;
}

const reactionsBox = () => screen.getByRole('checkbox', { name: /Emoji reactions/ });

beforeEach(() => {
	mocks.invalidate.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('Default features — saving', () => {
	it('adopts the server’s confirmed list, not the optimistic one', async () => {
		// The server is authoritative: it coerces (dedupe, drop junk), so the UI has
		// to take what came back rather than assume its own guess stuck.
		stubFetch(true, () => prefs({ defaultDisabledFeatures: ['reactions', 'web'] }));
		render(PreferencesPage, {
			props: { data: { prefs: prefs(), featureCategories: CATEGORIES } },
		});

		await userEvent.click(reactionsBox());

		expect(reactionsBox()).not.toBeChecked();
		// 'web' came back disabled too, and the UI reflects it.
		expect(screen.getByRole('checkbox', { name: /Web access/ })).not.toBeChecked();
	});

	it('puts the checkbox back when the save fails, so the next toggle can’t smuggle it through', async () => {
		const seen = stubFetch(false, () => prefs());
		render(PreferencesPage, {
			props: { data: { prefs: prefs(), featureCategories: CATEGORIES } },
		});

		await userEvent.click(reactionsBox());
		expect(reactionsBox()).toBeChecked(); // reverted

		// The follow-up toggle must carry only its own change. Before the revert,
		// it computed from the diverged array and quietly persisted the failed one.
		await userEvent.click(screen.getByRole('checkbox', { name: /Web access/ }));
		expect(seen[1].defaultDisabledFeatures).toEqual(['web']);
	});
});

describe('Default features — layout invalidation', () => {
	it('re-runs the layout load, so a new chat sees the new default', async () => {
		// The (app) layout hands `prefs` to the new-chat page, which seeds the
		// composer's toggles from it. Without this, turning reactions off and
		// starting a chat still got reactions until a hard reload.
		stubFetch(true, (p) => prefs(p));
		render(PreferencesPage, {
			props: { data: { prefs: prefs(), featureCategories: CATEGORIES } },
		});

		await userEvent.click(reactionsBox());

		expect(mocks.invalidate).toHaveBeenCalledWith('app:prefs');
	});

	it('does not re-run it for a preference only this page reads', async () => {
		// Scoped deliberately: invalidating re-runs the whole layout load —
		// conversations, models, skills, the feature catalogue — and "About you" is
		// read nowhere else, so doing it on every blur was pure waste.
		stubFetch(true, (p) => prefs(p));
		render(PreferencesPage, {
			props: { data: { prefs: prefs(), featureCategories: CATEGORIES } },
		});

		const about = screen.getByLabelText(/About you/i);
		await userEvent.type(about, 'I write Svelte');
		await userEvent.tab();

		expect(mocks.invalidate).not.toHaveBeenCalled();
	});
});
