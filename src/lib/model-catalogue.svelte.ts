/**
 * The client's view of the model catalogue, which is deliberately incomplete.
 *
 * The (app) layout ships only the entries first paint needs — the composer's
 * starting model and the sidebar's favourites — because an aggregator endpoint
 * advertises thousands of models and the full list is ~600KB. Most sessions
 * never need the rest: you launch, you talk to your default model, you close.
 * So the rest is fetched when something actually needs it — the whole list when
 * the picker opens, individual entries when a conversation or a restored intent
 * names one.
 *
 * NOT a module singleton, unlike `toast` / `privateView` / friends. Those are
 * one instance per server process and are safe only because nothing writes them
 * at component-init depth (see CLAUDE.md). This holds data seeded from a
 * specific user's layout payload, so a shared instance would publish one user's
 * catalogue into another user's SSR render. The (app) layout constructs one and
 * puts it in context; `getModelCatalogue()` reads it back. Context flows
 * downward, which is exactly the direction needed here.
 */
import { getContext, setContext } from 'svelte';
import { endpointIdOf, MAX_MODEL_IDS_PER_REQUEST } from '$lib/model-ids';
import type { ModelEntry } from '$lib/types/api';

/**
 * How much of the catalogue is present.
 *
 * `partial` is the normal resting state, not an error or a loading spinner —
 * it's what a session that never opens the picker stays in forever.
 */
export type CatalogueStatus = 'partial' | 'loading' | 'full';

/**
 * Whether an id names a real model.
 *
 * A string union rather than `boolean` (or `boolean | null`) on purpose. The
 * question is genuinely three-valued while the catalogue is partial, and the
 * mistake to design against is a caller writing `if (!catalogue.knows(id))` and
 * silently discarding a model that merely hadn't been fetched — that exact bug
 * has already dropped a favourited preset's system prompt and a whole compare
 * cart in this codebase. With a string union that mistake fails OPEN: every
 * non-empty string is truthy, so a careless caller treats unknown ids as valid
 * and the attempt surfaces as a server-side error instead of a silent drop.
 */
export type Membership = 'yes' | 'no' | 'unsure';

/** Presets (`custom::<id>`) live in `data.customModels`, never in the catalogue. */
const CUSTOM_PREFIX = 'custom::';

/**
 * Ceiling on a catalogue request.
 *
 * The server bounds its own upstream calls, so this is not about a slow endpoint
 * — it's about a stalled connection between browser and app, which would
 * otherwise leave the picker spinning on a promise that never settles, with no
 * retry because the in-flight entry is still occupied.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export class ModelCatalogue {
	/** The layout's first-paint slice, read through a getter so it stays reactive. */
	readonly #seed: () => ModelEntry[];
	/** Entries obtained since — by a full load, a targeted resolve, or adoption. */
	#extra = $state.raw<ModelEntry[]>([]);
	#status = $state<CatalogueStatus>('partial');
	/**
	 * Ids we have asked the server about by name. An id in here with no entry is
	 * a definitive "not configured" — that's what makes `membership` able to say
	 * `no` without having loaded the whole catalogue.
	 */
	#asked = $state.raw<ReadonlySet<string>>(new Set());
	/**
	 * Endpoints that failed on the last full load.
	 *
	 * Separate from `status` so the two questions a truncated listing raises can be
	 * answered independently: "have we fetched everything we're going to?" (yes —
	 * so stop refetching) and "is this id's absence meaningful?" (no, for these
	 * endpoints). Collapsing them into a permanent `partial` kept `ensureAll` from
	 * ever short-circuiting, so a box that is simply powered off — the ordinary
	 * state of a self-hosted inference machine — re-pulled the whole catalogue on
	 * every single picker open, which is the cost this class exists to avoid.
	 */
	#unresolvedEndpoints = $state.raw<ReadonlySet<string>>(new Set());
	/**
	 * Whether the last full load FAILED, as opposed to never having run.
	 *
	 * Both leave `status` at `partial` holding a first-paint slice, and the picker
	 * has to say different things about them: "still coming" versus "we tried and
	 * couldn't". Without the distinction a failed load drops straight from the
	 * spinner to `No matches for "…"` about a model that plainly exists — which is
	 * the confident wrong answer the loading state was added to prevent.
	 */
	#loadFailed = $state(false);
	/** In-flight de-duplication. Plain fields: nothing renders from them. */
	#allInFlight: Promise<void> | null = null;
	#idsInFlight = new Map<string, Promise<void>>();

	constructor(seed: () => ModelEntry[]) {
		this.#seed = seed;
	}

	get status(): CatalogueStatus {
		return this.#status;
	}

	/** True when the last attempt to load the catalogue failed. Cleared on retry. */
	get loadFailed(): boolean {
		return this.#loadFailed;
	}

	/** id -> entry, seed first so a later fetch of the same id can't reorder. */
	readonly #byId: ReadonlyMap<string, ModelEntry> = $derived.by(() => {
		const byId = new Map<string, ModelEntry>();
		for (const m of this.#seed()) byId.set(m.id, m);
		for (const m of this.#extra) byId.set(m.id, m);
		return byId;
	});

	/**
	 * Everything currently known, seed first so a later fetch of the same id
	 * doesn't reorder the list the picker renders.
	 */
	readonly all: ModelEntry[] = $derived.by(() => [...this.#byId.values()]);

	/**
	 * The entry for `id`, if we hold it.
	 *
	 * `undefined` conflates "no such model" with "not fetched yet", so this is for
	 * RENDERING — where both cases degrade the same way, to showing the raw id.
	 * Anything deciding whether an id is legitimate wants `membership`.
	 */
	entry(id: string): ModelEntry | undefined {
		return this.#byId.get(id);
	}

	membership(id: string): Membership {
		if (this.entry(id)) return 'yes';
		// Checked BEFORE the definitive answers: an id belonging to an endpoint that
		// did not answer is missing for a reason that has nothing to do with whether
		// it exists, and saying 'no' would outlive the outage.
		const endpointId = endpointIdOf(id);
		if (endpointId !== null && this.#unresolvedEndpoints.has(endpointId)) return 'unsure';
		if (this.#status === 'full' || this.#asked.has(id)) return 'no';
		return 'unsure';
	}

	/**
	 * Merge in entries obtained elsewhere — a page load that resolved the models its
	 * conversation refers to, say. Never fetches.
	 *
	 * Makes no claim about what ISN'T here unless `askedIds` says otherwise.
	 */
	adopt(entries: ReadonlyArray<ModelEntry | null | undefined>, askedIds?: readonly string[]): void {
		const incoming = entries.filter((m): m is ModelEntry => !!m);
		// Merged against `#extra` DIRECTLY, never through `entry()`.
		//
		// `entry()` reads `#byId`, and Svelte's server runtime memoizes a `$derived`
		// created during a render (`once()` — see svelte/src/internal/server/index.js).
		// Reading it here evaluates it BEFORE this write, latching the pre-adopt value
		// for the rest of the SSR pass — so the entries would land in `#extra` and
		// remain invisible to everything that renders afterwards, while the `#asked`
		// write below still took effect. That asymmetry made `membership()` answer a
		// definitive 'no' for a conversation's own perfectly valid model, and the
		// server-rendered composer read "Choose a model…" with Send disabled.
		//
		// Replaces a known id rather than skipping it, because the caller is handing
		// us a FRESHER read. A page load re-resolves its models on every navigation,
		// and fields do change underneath: `docs/configuration.md` promises the
		// context budget follows a `llama-server` restarted with a different
		// `--ctx-size` "on the next models-list load (opening a chat …)".
		if (incoming.length > 0) {
			const merged = new Map(this.#extra.map((m) => [m.id, m] as const));
			let changed = false;
			for (const m of incoming) {
				if (merged.get(m.id) !== m) {
					merged.set(m.id, m);
					changed = true;
				}
			}
			if (changed) this.#extra = [...merged.values()];
		}
		if (askedIds && askedIds.length > 0) {
			const merged = new Set(this.#asked);
			for (const id of askedIds) merged.add(id);
			if (merged.size !== this.#asked.size) this.#asked = merged;
		}
	}

	/** Load the whole catalogue. Idempotent, and concurrent callers share one request. */
	async ensureAll(): Promise<void> {
		if (this.#status === 'full') return;
		this.#allInFlight ??= this.#loadAll();
		return this.#allInFlight;
	}

	async #loadAll(): Promise<void> {
		this.#status = 'loading';
		this.#loadFailed = false;
		try {
			const res = await fetch('/api/models', {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`GET /api/models -> ${res.status}`);
			const body = (await res.json()) as {
				data?: ModelEntry[];
				endpoint_errors?: unknown[];
			};
			// Merged, not replaced: entries adopted from a page load (a conversation's
			// own models) would otherwise be dropped by opening the picker.
			this.adopt(body.data ?? []);
			// `full` here means "we have fetched everything this server is going to
			// give us", NOT "every configured model is present" — the two diverge when
			// an endpoint is down, and `#unresolvedEndpoints` carries that difference
			// so `membership` can answer 'unsure' for its ids without keeping the
			// whole catalogue in a state that re-fetches on every open.
			//
			// The catalogue is otherwise NOT refreshed once loaded. A model list
			// changing mid-session means an upstream gained a model, which is rare
			// enough on a self-hosted box to be worth a stale picker rather than a
			// refetch on every open.
			const errored = (body.endpoint_errors ?? []) as Array<{ endpointId?: string }>;
			this.#unresolvedEndpoints = new Set(
				errored.map((e) => e.endpointId).filter((id): id is string => !!id),
			);
			this.#status = 'full';
		} catch {
			this.#loadFailed = true;
			// Back to `partial`, which is a truthful description of what we hold and
			// leaves every consumer on its degraded-but-working path (raw ids, and a
			// `membership` of `unsure` rather than a wrong `no`). Cleared from
			// `#allInFlight` so the next opener retries instead of awaiting a
			// settled failure forever.
			this.#status = 'partial';
		} finally {
			this.#allInFlight = null;
		}
	}

	/**
	 * Resolve specific ids, skipping any already held or already asked about.
	 *
	 * Batched by design: the callers that need this restore whole compare carts
	 * and fan-outs, and one round trip per model would turn a cart into N.
	 */
	async ensure(ids: readonly string[]): Promise<void> {
		// Deliberately NOT short-circuited on `status === 'full'`. Since `full` now
		// means "fetched everything the server offered" rather than "every configured
		// model is present", an id on an endpoint that was down during that load is
		// still genuinely open — `membership` reports it 'unsure', and the filter
		// below is what decides there is nothing to do. Short-circuiting here would
		// make those ids unaskable forever.
		//
		// A full load already in flight will answer most of this, so wait for it
		// rather than issuing a redundant `?ids=` alongside. (Reachable: opening the
		// picker while a deep link or a restored intent is resolving.)
		const stillMissing = () => [
			...new Set(
				ids.filter((id) => id && !id.startsWith(CUSTOM_PREFIX) && this.membership(id) === 'unsure'),
			),
		];
		// Checked BEFORE waiting on any in-flight full load. Callers are click
		// handlers — "new chat from this prompt", a favourite tap — and the common
		// case is that every id is already held, so awaiting first would park a click
		// behind a whole-catalogue download (up to REQUEST_TIMEOUT_MS) to discover
		// there was nothing to do. The button just looks broken for that long.
		if (stillMissing().length === 0) return;
		if (this.#allInFlight) await this.#allInFlight;
		// Re-derived after the await: that load has probably answered these.
		const missing = stillMissing();
		if (missing.length === 0) return;
		const pending: Array<Promise<void>> = [];
		for (const id of missing) {
			const inFlight = this.#idsInFlight.get(id);
			if (inFlight) pending.push(inFlight);
		}
		const fresh = missing.filter((id) => !this.#idsInFlight.has(id));
		// Chunked to the server's own cap: it truncates a longer list, and every id
		// in a request is recorded as answered, so an over-long batch would remember
		// the dropped tail as "no such model" without asking. One constant, shared.
		for (let i = 0; i < fresh.length; i += MAX_MODEL_IDS_PER_REQUEST) {
			const chunk = fresh.slice(i, i + MAX_MODEL_IDS_PER_REQUEST);
			const request = this.#loadIds(chunk);
			for (const id of chunk) this.#idsInFlight.set(id, request);
			pending.push(request);
		}
		await Promise.all(pending);
	}

	async #loadIds(ids: readonly string[]): Promise<void> {
		try {
			const res = await fetch(`/api/models?ids=${encodeURIComponent(ids.join(','))}`, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`GET /api/models?ids -> ${res.status}`);
			const body = (await res.json()) as {
				data?: ModelEntry[];
				endpoint_errors?: unknown[];
			};
			// Recorded even for ids that came back empty — that absence IS the
			// answer, and recording it is what lets `membership` return `no` for a
			// stale favourite without loading the other two thousand models.
			//
			// UNLESS an endpoint failed. Then the absence means "that endpoint is
			// down right now", and remembering it as "no such model" would outlive
			// the outage: the id is never re-asked, so a health-flap during one tap
			// of a favourite would kill that link for the life of the page.
			const complete = (body.endpoint_errors?.length ?? 0) === 0;
			this.adopt(body.data ?? [], complete ? ids : undefined);
		} catch {
			// Leave them unrecorded so `membership` stays `unsure` and a later call
			// can retry. A network blip must not be remembered as "no such model".
		} finally {
			for (const id of ids) this.#idsInFlight.delete(id);
		}
	}
}

const KEY = Symbol('model-catalogue');

export function setModelCatalogue(catalogue: ModelCatalogue): ModelCatalogue {
	return setContext(KEY, catalogue);
}

export function getModelCatalogue(): ModelCatalogue {
	return getContext<ModelCatalogue>(KEY);
}
