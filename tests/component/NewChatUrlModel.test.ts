/* @vitest-environment happy-dom */

/**
 * Holds the line on `?model=` being applied per NAVIGATION, not per commit.
 *
 * The new-chat page picks up the model a sidebar favourite linked to
 * (`/?model=…`), and re-applying that param over a selection the user made by
 * hand is exactly what it must not do. An `$effect` reading `page.url` did
 * precisely that, because a commit is not a navigation: `page.url` is a
 * `$state.raw` holding a URL object that SvelteKit republishes on every load
 * re-run, `invalidate()` included — so the (app) layout's resume refresh
 * snapped the composer back to whatever the query string still said.
 *
 * The other direction matters too: tapping a favourite is a navigation and must
 * still apply, including when the user has since picked something else by hand.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'svelte';
import type { ModelEntry } from '$lib/types/api';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidate: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	afterNavigate: (callback: Parameters<ReturnType<typeof createKitStub>['afterNavigate']>[0]) =>
		stub().afterNavigate(callback),
	beforeNavigate: vi.fn(),
	replaceState: vi.fn(),
	pushState: vi.fn(),
}));
vi.mock('$app/state', async () => {
	const { createKitStub } = await import('./_helpers/kit-runtime-stub.svelte');
	holder.current = createKitStub('http://localhost:3000/?model=bridge::alpha');
	return { page: holder.current.page, navigating: holder.current.navigating };
});

import Harness from './_helpers/NewChatHarness.svelte';

function makeModel(id: string, displayName: string): ModelEntry {
	return {
		id,
		endpointId: 'bridge',
		upstreamId: displayName,
		displayName,
		ownedBy: null,
		kind: 'chat',
		kindKnown: true,
		group: 'Bridge',
		groupKey: 'bridge',
		supportsTools: false,
		contextWindow: null,
		promptStyle: null,
		promptHint: null,
	};
}

const models = [
	makeModel('bridge::alpha', 'alpha'),
	makeModel('bridge::beta', 'beta'),
	makeModel('bridge::gamma', 'gamma'),
];

const data = {
	user: { id: 'u1', displayName: 'Test', email: 't@e.st', role: 'admin', avatarUrl: null },
	prefs: { enterBehavior: 'send', favoriteModels: [], modelSets: [] },
	models,
	customModels: [],
	// Deliberately NOT the URL's model, so applying the param is observable.
	defaultModelId: 'bridge::gamma',
	conversations: [],
	generatingIds: [],
	enabledSkills: [],
	featureCategories: [],
	deferredLoaded: true,
	mcpSettled: true,
};

beforeEach(() => {
	stub().reset();
	globalThis.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: models, endpoint_errors: [] }), { status: 200 }),
	) as typeof fetch;
});

/** The picker's collapsed trigger shows the current selection. */
const selected = () => screen.getByLabelText('Select model').textContent?.trim() ?? '';

/** Render, then dispatch the `enter` navigation a hydrated document gets. */
function renderPage() {
	render(Harness, { props: { data } });
	stub().enter();
}

describe('new-chat page — ?model= from the URL', () => {
	it('applies the param, then leaves a manual pick alone across a data refresh', async () => {
		const user = userEvent.setup();
		renderPage();
		// The apply resolves the id through the catalogue first, so it lands a
		// microtask after mount rather than synchronously.
		await vi.waitFor(() => expect(selected()).toContain('alpha'));

		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByRole('option', { name: /beta/ }));
		expect(selected()).toContain('beta');

		// What `invalidate()` commits: same href, new URL + data objects, no
		// navigation. The query string still says `alpha`; the user's pick wins.
		stub().refreshData({ conversations: [] });
		flushSync();
		// A re-applied param would land through the same async catalogue resolve
		// the initial apply used, so give it more than a microtask to appear.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(selected()).toContain('beta');
	});

	it('applies the param when a favourite navigates to a new one', async () => {
		renderPage();
		await vi.waitFor(() => expect(selected()).toContain('alpha'));

		stub().navigate('http://localhost:3000/?model=bridge::beta');
		await vi.waitFor(() => expect(selected()).toContain('beta'));
	});

	it('re-applies a favourite tapped again after a manual pick', async () => {
		const user = userEvent.setup();
		renderPage();
		await vi.waitFor(() => expect(selected()).toContain('alpha'));

		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByRole('option', { name: /beta/ }));
		expect(selected()).toContain('beta');

		// "New chat" drops the param without touching the selection...
		stub().navigate('http://localhost:3000/');
		flushSync();
		expect(selected()).toContain('beta');

		// ...and tapping the alpha favourite again is a fresh instruction, even
		// though alpha is the last value this page applied from a URL.
		stub().navigate('http://localhost:3000/?model=bridge::alpha');
		await vi.waitFor(() => expect(selected()).toContain('alpha'));
	});
});
