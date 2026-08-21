/**
 * Making an endpoint let go of the resource it shares.
 *
 * `resource_group` stops two endpoints generating at once, which is necessary
 * and not sufficient: a llama-server keeps a model resident after a turn
 * finishes, so an image generation dispatched into an *idle* group can still
 * OOM on VRAM nothing is using. Serializing can't help with memory that's
 * merely held. Something has to ask the backend to drop it.
 *
 * A named strategy rather than a configured URL+body. The obvious generic shape
 * — "POST this when you need the GPU back" — can't express what llama.cpp
 * actually requires, which is list-the-loaded-models-then-unload-each: unload
 * takes a specific model id and there is no unload-all. A webhook would also
 * have to be told which model, and the only correct answer is "whichever one is
 * loaded right now", which is a query, not a config value. This is the same
 * shape as `provider_quirk`: vendor behaviour in code, isolated, opted into per
 * endpoint.
 */

import { logLevel } from '../env';
import type { LoadedEndpoint } from './config';

const DEBUG = logLevel() === 'debug';

/** Strategies an endpoint can name via `release = "…"` in config.toml. */
export const RELEASE_STRATEGIES = ['llama-cpp-router'] as const;
export type ReleaseStrategy = (typeof RELEASE_STRATEGIES)[number];

export function isReleaseStrategy(v: unknown): v is ReleaseStrategy {
	return typeof v === 'string' && (RELEASE_STRATEGIES as readonly string[]).includes(v);
}

/**
 * llama.cpp's model-management API lives at the SERVER ROOT, not under `/v1` —
 * `/models`, `/models/unload` — while `base_url` points at the OpenAI-compatible
 * `/v1`. Derive one from the other rather than asking operators to configure the
 * same host twice.
 *
 * Strips a single trailing `/v1` (with or without a trailing slash) and nothing
 * else: a deployment terminating at a path prefix keeps that prefix, which is
 * the behaviour you want behind a reverse proxy.
 */
export function managementRootFrom(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, '');
	return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed;
}

interface ModelRow {
	id: string;
	status?: { value?: string };
}

/**
 * How a bounded wait ended, and how long it actually took.
 *
 * The elapsed time is carried out rather than reconstructed from the constants:
 * a per-model deadline is clamped by the overall budget, so `BUSY_WAIT_MS` and
 * `UNLOAD_WAIT_MS` can overstate the real wait by orders of magnitude. These
 * warnings are the operator's only signal that the GPU wasn't freed, so they
 * have to report what happened.
 */
interface Waited {
	ok: boolean;
	waitedMs: number;
}

/** How long to wait for a model that's mid-inference before giving up on it. */
const BUSY_WAIT_MS = 60_000;
/** How long to wait for an unload to actually take effect. */
const UNLOAD_WAIT_MS = 120_000;
const POLL_MS = 250;
/**
 * Ceiling on the WHOLE handover, not per model.
 *
 * The per-model budgets are what a single stubborn model is worth waiting; they
 * were also, accidentally, the only bound — so N resident models cost N times
 * that, serially, with the group's slot held and every other member's requests
 * queued behind it. Set just above one model's worst case (60s busy + 30s
 * unload + 120s confirm), so the common single-model path is unchanged and only
 * the pathological multi-model one is capped.
 */
const RELEASE_BUDGET_MS = 240_000;

/**
 * Duplicated from `client.ts`'s private `authHeaders` rather than imported: this
 * module is pulled in by `config.ts` for `RELEASE_STRATEGIES`, and `client.ts`
 * would drag its whole graph (url-policy, abort utils) into config's — which has
 * already broken unrelated test mocks once. Two lines is the cheaper coupling.
 */
function authHeaders(endpoint: LoadedEndpoint): Record<string, string> {
	return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
}

async function getJson<T>(
	url: string,
	endpoint: LoadedEndpoint,
	signal: AbortSignal | undefined,
	timeoutMs = 10_000,
) {
	const res = await fetch(url, {
		headers: authHeaders(endpoint),
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
	return (await res.json()) as T;
}

/** Models the router currently reports as anything other than `unloaded`. */
async function loadedModels(
	root: string,
	endpoint: LoadedEndpoint,
	signal?: AbortSignal,
	/** Apply the is-this-really-a-router check. Only for the FIRST listing: on
	 *  the confirmation poll a status-less response is indistinguishable from
	 *  the unload having worked, and treating it as a fault would report a
	 *  success as a failure and re-evict on every later acquire. */
	strict = false,
): Promise<string[]> {
	const body = await getJson<{ data?: ModelRow[] }>(`${root}/models`, endpoint, signal);
	const rows = body.data;
	// "Nothing is loaded" and "this response has no residency information" both
	// used to come back as an empty list — i.e. as a successful handover. The
	// realistic way to hit the second is pointing `release` at a plain
	// llama-server instead of one in router mode: `/models` answers 200 with
	// rows that carry no `status`, so the feature validates, does nothing, and
	// says nothing. Fail loudly instead; a genuinely empty `data: []` is fine.
	if (!Array.isArray(rows)) throw new Error(`GET ${root}/models: response has no "data" array`);
	if (strict && rows.length > 0 && !rows.some((m) => m.status?.value)) {
		throw new Error(
			`GET ${root}/models: no model reports a status — is this llama-server running in router mode?`,
		);
	}
	return rows.filter((m) => m.status?.value && m.status.value !== 'unloaded').map((m) => m.id);
}

/**
 * Wait while a model is serving a request.
 *
 * Only ever called for a model already reported as loaded. That ordering is
 * load-bearing: `/slots?model=…` AUTOLOADS the model when the router hasn't got
 * it (autoload is on unless `--no-models-autoload`), so probing speculatively
 * would load a model in order to decide whether to unload it — the exact
 * opposite of the point, on the one operation that is expensive here.
 *
 * It can't be our own traffic keeping it busy: the gate only releases a group
 * that is idle, so a busy slot means something else is pointed at this backend.
 * Waiting is the polite reading — we're effectively queueing behind them —
 * rather than yanking a model out from under a request mid-generation, which
 * llama.cpp's docs don't define the behaviour of.
 */
async function waitUntilIdle(
	root: string,
	endpoint: LoadedEndpoint,
	model: string,
	budgetEnd: number,
	signal?: AbortSignal,
): Promise<Waited> {
	const startedAt = Date.now();
	const deadline = Math.min(startedAt + BUSY_WAIT_MS, budgetEnd);
	for (;;) {
		const slots = await getJson<Array<{ is_processing?: boolean }>>(
			`${root}/slots?model=${encodeURIComponent(model)}`,
			endpoint,
			signal,
		);
		if (!slots.some((s) => s.is_processing)) return { ok: true, waitedMs: Date.now() - startedAt };
		if (Date.now() > deadline) return { ok: false, waitedMs: Date.now() - startedAt };
		await sleep(POLL_MS, signal);
	}
}

/**
 * Wait for the model to actually be gone.
 *
 * `POST /models/unload` answers `{"success":true}` BEFORE the unload completes —
 * measured against a live router, the model was still reported loaded on the
 * very next request. Treating the 200 as done is how you hand a still-occupied
 * GPU to the next generation and OOM anyway, which is the failure this whole
 * mechanism exists to prevent.
 */
async function waitUntilUnloaded(
	root: string,
	endpoint: LoadedEndpoint,
	model: string,
	budgetEnd: number,
	signal?: AbortSignal,
): Promise<Waited> {
	const startedAt = Date.now();
	const deadline = Math.min(startedAt + UNLOAD_WAIT_MS, budgetEnd);
	for (;;) {
		if (!(await loadedModels(root, endpoint, signal)).includes(model)) {
			return { ok: true, waitedMs: Date.now() - startedAt };
		}
		if (Date.now() > deadline) return { ok: false, waitedMs: Date.now() - startedAt };
		await sleep(POLL_MS, signal);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			// Reject with the signal's OWN reason, not a fabricated AbortError.
			// Only a real abort is meant to escape this module; a caller passing
			// `AbortSignal.timeout(…)` (the title generator does) aborts with a
			// TimeoutError, which is meant to be swallowed like any other failure.
			// Minting an AbortError here laundered it into the one error we
			// rethrow — and since the poll loops spend most of their wall clock in
			// these 250ms sleeps, that is where such a signal usually lands.
			reject(
				signal?.reason instanceof Error
					? signal.reason
					: new DOMException('Aborted while releasing endpoint', 'AbortError'),
			);
		};
		// Removed on the normal path too: the loops sleep up to 720 times per
		// model, all on the request's own long-lived signal, and `once` only
		// collects the listener if the abort actually fires. Left in, a single
		// release trips Node's MaxListenersExceededWarning and pins that many
		// dead closures for the rest of the turn.
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Ask `endpoint` to free the resource it shares, and don't return until it has.
 *
 * Best-effort by contract: a failure here logs and resolves, leaving the caller
 * to proceed. The alternative — failing the user's generation because an
 * unrelated backend wouldn't let go — is worse than the status quo it's trying
 * to improve on, since without this the generation would simply have been
 * attempted anyway. An ABORT is different and rethrows: that's the user's Stop,
 * and they should not be made to wait out an unload they cancelled.
 *
 * Returns whether everything the router reported loaded is now gone. Callers
 * use it to decide whether the handover really happened — "we tried" and "it
 * worked" have to be distinguishable, or a failure gets recorded as a success
 * and the retry (the request that most needs the eviction) skips it.
 *
 * Every failure is reported at WARN, not debug. Each one means the GPU was not
 * freed, which is this function's whole job; discovering that only from the
 * OOM it was supposed to prevent is not a reasonable ask of an operator.
 */
export async function releaseEndpointResources(
	endpoint: LoadedEndpoint,
	signal?: AbortSignal,
): Promise<boolean> {
	if (endpoint.release !== 'llama-cpp-router') return true;
	const root = managementRootFrom(endpoint.baseUrl);

	let loaded: string[];
	try {
		loaded = await loadedModels(root, endpoint, signal, true);
	} catch (e) {
		if (isAbort(e)) throw e;
		warnRelease(endpoint, `could not list loaded models: ${describe(e)}`);
		return false;
	}
	if (loaded.length === 0) return true;

	const budgetEnd = Date.now() + RELEASE_BUDGET_MS;
	let allFreed = true;
	for (const model of loaded) {
		if (Date.now() >= budgetEnd) {
			warnRelease(endpoint, `gave up after ${RELEASE_BUDGET_MS}ms with models still loaded`);
			return false;
		}
		// Per model, not per call: one model's transient 503 used to abandon every
		// model after it, silently leaving them resident — the exact OOM this
		// exists to prevent, on a router holding more than one.
		try {
			const idle = await waitUntilIdle(root, endpoint, model, budgetEnd, signal);
			if (!idle.ok) {
				warnRelease(endpoint, `${model} still busy after ${idle.waitedMs}ms, leaving it loaded`);
				allFreed = false;
				continue;
			}
			const res = await fetch(`${root}/models/unload`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...authHeaders(endpoint) },
				body: JSON.stringify({ model }),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
					: AbortSignal.timeout(30_000),
			});
			if (!res.ok) throw new Error(`POST ${root}/models/unload → HTTP ${res.status}`);
			const gone = await waitUntilUnloaded(root, endpoint, model, budgetEnd, signal);
			if (gone.ok) {
				if (DEBUG)
					console.debug(`[release] ${endpoint.id}: ${model} unloaded in ${gone.waitedMs}ms`);
			} else {
				warnRelease(endpoint, `${model} did not unload within ${gone.waitedMs}ms`);
				allFreed = false;
			}
		} catch (e) {
			if (isAbort(e)) throw e;
			warnRelease(endpoint, `could not free ${model}: ${describe(e)}`);
			allFreed = false;
		}
	}
	return allFreed;
}

function isAbort(e: unknown): boolean {
	return e instanceof Error && e.name === 'AbortError';
}

function describe(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function warnRelease(endpoint: LoadedEndpoint, detail: string): void {
	console.warn(`[release] ${endpoint.id}: ${detail}`);
}
