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

	it('records that a load FAILED, distinctly from never having run', async () => {
		// Both leave a short list behind, and the picker must say different things
		// about them — otherwise a failed load reads as "loaded, and your model isn't
		// in it", which is the confident wrong answer the loading state exists to
		// prevent.
		const c = make();
		expect(c.loadFailed).toBe(false);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve({ ok: false, status: 503 } as Response)),
		);
		await c.ensureAll();
		expect(c.loadFailed).toBe(true);
		expect(c.status).toBe('partial');

		// Cleared when a retry begins, so a recovered load stops claiming failure.
		vi.stubGlobal('fetch', stubFetch([entry('ep::remote')]));
		await c.ensureAll();
		expect(c.loadFailed).toBe(false);
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

	it('records a definitive NO when told which ids were looked up', () => {
		// Without this, a server that looked an id up and found nothing had no way
		// to say so: adopt can only add entries, so the id stayed 'unsure' forever
		// and the chat page's invalid-model submit gate failed open — Send enabled
		// on a conversation whose model the config no longer serves.
		const c = make();
		c.adopt([], ['ep::deconfigured']);
		expect(c.membership('ep::deconfigured')).toBe('no');
	});

	it('still says yes for ids that did resolve in the same answer', () => {
		const c = make();
		c.adopt([entry('ep::alive')], ['ep::alive', 'ep::gone']);
		expect(c.membership('ep::alive')).toBe('yes');
		expect(c.membership('ep::gone')).toBe('no');
	});

	it('makes no negative claim when the ids are omitted', () => {
		const c = make();
		c.adopt([entry('ep::alive')]);
		expect(c.membership('ep::gone')).toBe('unsure');
	});

	it('REPLACES a known entry, because the caller has a fresher read', () => {
		// Not a no-op. A page load re-resolves its models on every navigation, and
		// fields do change underneath: docs/configuration.md promises the context
		// budget follows a `llama-server` restarted with a different `--ctx-size`
		// "on the next models-list load (opening a chat …)". Skipping a known id
		// would freeze contextWindow at first sight for the whole session.
		const c = make();
		c.adopt([{ ...entry('ep::m'), contextWindow: 4096 } as ModelEntry]);
		expect(c.entry('ep::m')?.contextWindow).toBe(4096);
		c.adopt([{ ...entry('ep::m'), contextWindow: 65536 } as ModelEntry]);
		expect(c.entry('ep::m')?.contextWindow).toBe(65536);
	});
});

describe('resilience', () => {
	it('does not remember a failing endpoint as "no such model"', async () => {
		// /api/models degrades a down endpoint to its models being ABSENT. Recording
		// that absence would outlive the outage — the id is never re-asked, so one
		// health-flap would kill a favourite's link for the life of the page.
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ data: [], endpoint_errors: [{ endpointId: 'ep' }] }),
				} as Response),
			),
		);
		const c = make();
		await c.ensure(['ep::flapping']);
		expect(c.membership('ep::flapping')).toBe('unsure');

		vi.stubGlobal('fetch', stubFetch([entry('ep::flapping')]));
		await c.ensure(['ep::flapping']);
		expect(c.membership('ep::flapping')).toBe('yes');
	});

	it('DOES latch a negative when the server reports no endpoint errors', async () => {
		// The other half of the pair above, and the reason both are pinned: for a
		// while the client's outage guard was unreachable because the server always
		// sent `endpoint_errors: []`, and only the failing-endpoint test existed — so
		// it passed against a shape production never produced. These two now assert
		// the shapes are treated DIFFERENTLY.
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ data: [], endpoint_errors: [] }),
				} as Response),
			),
		);
		const c = make();
		await c.ensure(['ep::deconfigured']);
		expect(c.membership('ep::deconfigured')).toBe('no');
	});

	it("keeps a downed endpoint's ids askable after a full load, without refetching", async () => {
		// The two questions a truncated listing raises, answered separately. We have
		// everything the server offered (so stop pulling the whole catalogue on every
		// picker open — a powered-off inference box is an ordinary state), but the
		// missing endpoint's ids are still open questions, not answered ones.
		const fetchMock = vi.fn((url: string) =>
			Promise.resolve({
				ok: true,
				json: () =>
					Promise.resolve(
						String(url).includes('ids=')
							? { data: [entry('down::later')], endpoint_errors: [] }
							: { data: [entry('ep::alive')], endpoint_errors: [{ endpointId: 'down' }] },
					),
			} as Response),
		);
		vi.stubGlobal('fetch', fetchMock);
		const c = make();
		await c.ensureAll();
		expect(c.status).toBe('full');
		expect(c.membership('down::later')).toBe('unsure');

		// A second open must not re-pull the catalogue...
		await c.ensureAll();
		expect(fetchMock.mock.calls.length).toBe(1);
		// ...but the unresolved endpoint's ids must still be reachable by id.
		await c.ensure(['down::later']);
		expect(c.membership('down::later')).toBe('yes');
	});

	it('still answers no for a missing id on an endpoint that DID respond', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							data: [entry('ep::alive')],
							endpoint_errors: [{ endpointId: 'down' }],
						}),
				} as Response),
			),
		);
		const c = make();
		await c.ensureAll();
		expect(c.membership('ep::deconfigured')).toBe('no');
	});

	it('never answers no for a model whose endpoint did not respond', async () => {
		// The invariant, stated independently of how it is implemented: a listing
		// missing a down endpoint's models cannot make that endpoint's absences
		// definitive. Answering 'no' here would disable Send on a conversation that
		// worked a moment ago.
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({ data: [entry('ep::alive')], endpoint_errors: [{ endpointId: 'x' }] }),
				} as Response),
			),
		);
		const c = make();
		await c.ensureAll();
		expect(c.membership('ep::alive')).toBe('yes');
		expect(c.membership('x::down-endpoint-model')).toBe('unsure');
	});

	it('keeps entries adopted from a page load when the picker loads the catalogue', async () => {
		// `#loadAll` used to replace `#extra` outright, dropping a conversation's own
		// models — resolved server-side precisely because they are not in the seed.
		vi.stubGlobal('fetch', stubFetch([entry('ep::remote')]));
		const c = make();
		c.adopt([entry('ep::from-page-load')], ['ep::from-page-load']);
		await c.ensureAll();
		expect(c.membership('ep::from-page-load')).toBe('yes');
		expect(c.membership('ep::remote')).toBe('yes');
	});

	it('splits a batch larger than the server will answer in one request', async () => {
		// The server caps `?ids=` and silently drops the tail; since a request marks
		// everything it sent as asked, an over-long batch would remember the dropped
		// ids as definitively absent without having asked about them.
		const c = make();
		const ids = Array.from({ length: 450 }, (_, i) => `ep::m${i}`);
		await c.ensure(ids);
		const calls = vi.mocked(fetch).mock.calls;
		expect(calls.length).toBe(3);
		for (const [url] of calls) {
			// The stub is called with a string; assert that rather than coercing, so
			// a future change to a Request object fails loudly instead of stringifying
			// to '[object Object]' and silently passing.
			expect(typeof url).toBe('string');
			const sent = new URL(url as string, 'http://localhost').searchParams.get('ids');
			expect(sent!.split(',').length).toBeLessThanOrEqual(200);
		}
	});

	it('does not park a caller behind a full load it does not need', async () => {
		// `ensure` is called from click handlers. If every id is already held, waiting
		// on an in-flight catalogue download just to discover there was nothing to do
		// leaves the button looking broken for the length of that download.
		let releaseAll!: () => void;
		const gate = new Promise<void>((r) => (releaseAll = r));
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				gate.then(
					() =>
						({
							ok: true,
							json: () => Promise.resolve({ data: [entry('ep::remote')], endpoint_errors: [] }),
						}) as Response,
				),
			),
		);
		const c = make();
		const all = c.ensureAll();
		// Seeded ids need nothing, so this must settle without waiting on `all`.
		await c.ensure(['ep::seeded']);
		releaseAll();
		await all;
	});

	it('waits for an in-flight full load instead of racing it', async () => {
		const c = make();
		const all = c.ensureAll();
		await c.ensure(['ep::remote']);
		await all;
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(c.membership('ep::remote')).toBe('yes');
	});
});
