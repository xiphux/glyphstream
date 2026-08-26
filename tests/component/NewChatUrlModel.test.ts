/* @vitest-environment happy-dom */

/**
 * Holds the line on `?model=` being applied per URL VALUE, not per effect run.
 *
 * The new-chat page picks up the model a sidebar favourite linked to
 * (`/?model=…`), and the effect that does it deliberately untracks everything
 * but the URL — re-applying the param over a selection the user made by hand is
 * exactly what it must not do. Reading `page.url` inside the effect did not buy
 * that: `page.url` is a `$state.raw` holding a URL object, and SvelteKit
 * publishes a `new URL(...)` on every load re-run whose data changed — which is
 * every `invalidate()`, since it compares node data by reference. So the (app)
 * layout's resume refresh re-ran this effect and snapped the composer back to
 * whatever the query string still said.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'svelte';
import type { ModelEntry } from '$lib/types/api';
import type { createPageStub } from './_helpers/page-state-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createPageStub> | null }));

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidate: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	replaceState: vi.fn(),
	pushState: vi.fn(),
}));
vi.mock('$app/state', async () => {
	const { createPageStub } = await import('./_helpers/page-state-stub.svelte');
	holder.current = createPageStub('http://localhost:3000/?model=bridge::alpha');
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

function stub() {
	if (!holder.current) throw new Error('$app/state stub was never built');
	return holder.current;
}

beforeEach(() => {
	globalThis.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: models, endpoint_errors: [] }), { status: 200 }),
	) as typeof fetch;
});

/** The picker's collapsed trigger shows the current selection. */
const selected = () => screen.getByLabelText('Select model').textContent?.trim() ?? '';

describe('new-chat page — ?model= from the URL', () => {
	it('applies the param, then leaves a manual pick alone across a data refresh', async () => {
		const user = userEvent.setup();
		render(Harness, { props: { data } });
		// The apply resolves the id through the catalogue first, so it lands a
		// microtask after mount rather than synchronously.
		await vi.waitFor(() => expect(selected()).toContain('alpha'));

		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByRole('option', { name: /beta/ }));
		expect(selected()).toContain('beta');

		// What `invalidate()` commits: same href, new URL + data objects. The
		// query string still says `alpha`; the user's pick still wins.
		stub().refreshData({ conversations: [] });
		flushSync();
		// A re-applied param would land through the same async catalogue resolve
		// the initial apply used, so give it more than a microtask to appear.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(selected()).toContain('beta');
	});

	it('still applies the param when a favourite navigates to a new one', async () => {
		render(Harness, { props: { data } });
		await vi.waitFor(() => expect(selected()).toContain('alpha'));

		stub().navigate('http://localhost:3000/?model=bridge::beta');
		await vi.waitFor(() => expect(selected()).toContain('beta'));
	});
});
