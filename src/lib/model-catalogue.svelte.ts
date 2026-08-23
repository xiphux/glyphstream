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
	/** In-flight de-duplication. Plain fields: nothing renders from them. */
	#allInFlight: Promise<void> | null = null;
	#idsInFlight = new Map<string, Promise<void>>();

	constructor(seed: () => ModelEntry[]) {
		this.#seed = seed;
	}

	get status(): CatalogueStatus {
		return this.#status;
	}

	/**
	 * Everything currently known, seed first so a later fetch of the same id
	 * doesn't reorder the list the picker renders.
	 */
	readonly all: ModelEntry[] = $derived.by(() => {
		const seed = this.#seed();
		if (this.#extra.length === 0) return seed;
		const byId = new Map<string, ModelEntry>();
		for (const m of seed) byId.set(m.id, m);
		for (const m of this.#extra) byId.set(m.id, m);
		return [...byId.values()];
	});

	/**
	 * The entry for `id`, if we hold it.
	 *
	 * `undefined` conflates "no such model" with "not fetched yet", so this is for
	 * RENDERING — where both cases degrade the same way, to showing the raw id.
	 * Anything deciding whether an id is legitimate wants `membership`.
	 */
	entry(id: string): ModelEntry | undefined {
		return this.all.find((m) => m.id === id);
	}

	membership(id: string): Membership {
		if (this.entry(id)) return 'yes';
		if (this.#status === 'full' || this.#asked.has(id)) return 'no';
		return 'unsure';
	}

	/**
	 * Merge in entries obtained elsewhere — a page load that resolved its own
	 * conversation's model server-side, say. No fetch, and no claim about what
	 * ISN'T here.
	 */
	adopt(entries: ReadonlyArray<ModelEntry | null | undefined>): void {
		const fresh = entries.filter((m): m is ModelEntry => !!m && !this.entry(m.id));
		if (fresh.length > 0) this.#extra = [...this.#extra, ...fresh];
	}

	/** Load the whole catalogue. Idempotent, and concurrent callers share one request. */
	async ensureAll(): Promise<void> {
		if (this.#status === 'full') return;
		this.#allInFlight ??= this.#loadAll();
		return this.#allInFlight;
	}

	async #loadAll(): Promise<void> {
		this.#status = 'loading';
		try {
			const res = await fetch('/api/models');
			if (!res.ok) throw new Error(`GET /api/models -> ${res.status}`);
			const body = (await res.json()) as { data?: ModelEntry[] };
			this.#extra = body.data ?? [];
			this.#status = 'full';
		} catch {
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
		if (this.#status === 'full') return;
		const missing = [
			...new Set(
				ids.filter((id) => id && !id.startsWith(CUSTOM_PREFIX) && this.membership(id) === 'unsure'),
			),
		];
		if (missing.length === 0) return;
		const pending: Array<Promise<void>> = [];
		for (const id of missing) {
			const inFlight = this.#idsInFlight.get(id);
			if (inFlight) pending.push(inFlight);
		}
		const fresh = missing.filter((id) => !this.#idsInFlight.has(id));
		if (fresh.length > 0) {
			const request = this.#loadIds(fresh);
			for (const id of fresh) this.#idsInFlight.set(id, request);
			pending.push(request);
		}
		await Promise.all(pending);
	}

	async #loadIds(ids: readonly string[]): Promise<void> {
		try {
			const res = await fetch(`/api/models?ids=${encodeURIComponent(ids.join(','))}`);
			if (!res.ok) throw new Error(`GET /api/models?ids -> ${res.status}`);
			const body = (await res.json()) as { data?: ModelEntry[] };
			this.adopt(body.data ?? []);
			// Recorded even for ids that came back empty — that absence IS the
			// answer, and recording it is what lets `membership` return `no` for a
			// stale favourite without loading the other two thousand models.
			this.#asked = new Set([...this.#asked, ...ids]);
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
