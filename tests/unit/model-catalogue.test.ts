/* @vitest-environment happy-dom */
/**
 * The client's partial view of the model catalogue.
 *
 * Every assertion here is really about one thing: that "I don't have this
 * model" is never allowed to masquerade as "this model doesn't exist". That
 * conflation has already, in this codebase, dropped a favourited preset's
 * system prompt and silently emptied a restored compare cart — and it is
 * invisible when it happens, because the app carries on with a plausible
 * substitute rather than failing.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ModelCatalogue } from '../../src/lib/model-catalogue.svelte';
import type { ModelEntry } from '../../src/lib/types/api';

function entry(id: string, kind = 'chat'): ModelEntry {
	return {
		id,
		endpointId: id.split('::')[0],
		upstreamId: id.split('::')[1] ?? id,
		displayName: id,
		ownedBy: 'test',
		kind,
		kindKnown: true,
	} as ModelEntry;
}

const SEED = [entry('ep::seeded')];

/** Answers `?ids=` from `available`, and the full listing with all of it. */
function stubFetch(available: ModelEntry[]) {
	return vi.fn((url: string) => {
		const parsed = new URL(url, 'http://localhost');
		const ids = parsed.searchParams.get('ids');
		const data = ids ? available.filter((m) => ids.split(',').includes(m.id)) : available;
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ data }) } as Response);
	});
}

/**
 * Constructed with no effect owner, which is deliberate here.
 *
 * CLAUDE.md warns that reading a `$derived` outside an owner recomputes eagerly
 * and can hide a reactivity bug — that warning is about tests asserting that
 * something RE-RENDERS. These assert what the store answers, so eager recompute
 * is the behaviour under test, not a mask over it. A reactivity regression here
 * would surface in the component tests that render a picker.
 */
function make(seed: ModelEntry[] = SEED): ModelCatalogue {
	return new ModelCatalogue(() => seed);
}

beforeEach(() => {
	vi.stubGlobal('fetch', stubFetch([entry('ep::remote'), entry('ep::other')]));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('membership', () => {
	it('answers yes from the seed without any request', () => {
		const c = make();
		expect(c.membership('ep::seeded')).toBe('yes');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('says unsure — not no — for an id it simply has not fetched', () => {
		// The whole point. `no` here is what silently drops a valid model.
		expect(make().membership('ep::remote')).toBe('unsure');
	});

	it('says no once the server has been asked and did not have it', async () => {
		const c = make();
		await c.ensure(['ep::nonexistent']);
		expect(c.membership('ep::nonexistent')).toBe('no');
	});

	it('says no for anything absent once the whole catalogue is loaded', async () => {
		const c = make();
		await c.ensureAll();
		expect(c.status).toBe('full');
		expect(c.membership('ep::nonexistent')).toBe('no');
		expect(c.membership('ep::remote')).toBe('yes');
	});
});

describe('ensure', () => {
	it('resolves an id and makes it renderable', async () => {
		const c = make();
		await c.ensure(['ep::remote']);
		expect(c.membership('ep::remote')).toBe('yes');
		expect(c.entry('ep::remote')?.displayName).toBe('ep::remote');
	});

	it('asks for every missing id in ONE request', async () => {
		// A restored compare cart names several models at once; one round trip per
		// entry is what the batching exists to avoid.
		const c = make();
		await c.ensure(['ep::remote', 'ep::other']);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(vi.mocked(fetch).mock.calls[0][0]).toContain('ids=');
		expect(c.membership('ep::other')).toBe('yes');
	});

	it('skips ids it already holds, and presets entirely', async () => {
		const c = make();
		// Presets live in `customModels`; asking the catalogue about one would
		// always come back empty and then be remembered as "no such model".
		await c.ensure(['ep::seeded', 'custom::preset', '']);
		expect(fetch).not.toHaveBeenCalled();
		expect(c.membership('custom::preset')).toBe('unsure');
	});

	it('does not re-ask for an id it has already resolved', async () => {
		const c = make();
		await c.ensure(['ep::remote']);
		await c.ensure(['ep::remote']);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('shares one request between concurrent callers', async () => {
		const c = make();
		await Promise.all([c.ensure(['ep::remote']), c.ensure(['ep::remote'])]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('stays unsure when the request fails, and retries later', async () => {
		// A network blip must never be remembered as "no such model" — that would
		// turn a dropped packet into a permanently missing model for the session.
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.reject(new Error('offline'))),
		);
		const c = make();
		await c.ensure(['ep::remote']);
		expect(c.membership('ep::remote')).toBe('unsure');

		vi.stubGlobal('fetch', stubFetch([entry('ep::remote')]));
		await c.ensure(['ep::remote']);
		expect(c.membership('ep::remote')).toBe('yes');
	});
});

describe('ensureAll', () => {
	it('is idempotent and shares one request', async () => {
		const c = make();
		await Promise.all([c.ensureAll(), c.ensureAll()]);
		await c.ensureAll();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('falls back to partial on failure rather than claiming completeness', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve({ ok: false, status: 503 } as Response)),
		);
		const c = make();
		await c.ensureAll();
		expect(c.status).toBe('partial');
		// Still truthful about what it holds, and still refusing to guess.
		expect(c.membership('ep::seeded')).toBe('yes');
		expect(c.membership('ep::remote')).toBe('unsure');
	});

	it('keeps the seed even if the server omits it', async () => {
		vi.stubGlobal('fetch', stubFetch([entry('ep::remote')]));
		const c = make();
		await c.ensureAll();
		expect(c.membership('ep::seeded')).toBe('yes');
	});
});

describe('adopt', () => {
	it('merges an entry resolved elsewhere without claiming anything else', () => {
		// The chat page's own load resolves its conversation's model server-side.
		const c = make();
		c.adopt([entry('ep::from-page-load'), null, undefined]);
		expect(c.membership('ep::from-page-load')).toBe('yes');
		expect(c.membership('ep::remote')).toBe('unsure');
		expect(c.status).toBe('partial');
	});
});
