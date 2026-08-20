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

/** How long to wait for a model that's mid-inference before giving up on it. */
const BUSY_WAIT_MS = 60_000;
/** How long to wait for an unload to actually take effect. */
const UNLOAD_WAIT_MS = 120_000;
const POLL_MS = 250;

async function getJson<T>(url: string, signal: AbortSignal | undefined, timeoutMs = 10_000) {
	const res = await fetch(url, {
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
	return (await res.json()) as T;
}

/** Models the router currently reports as anything other than `unloaded`. */
async function loadedModels(root: string, signal?: AbortSignal): Promise<string[]> {
	const body = await getJson<{ data?: ModelRow[] }>(`${root}/models`, signal);
	return (body.data ?? [])
		.filter((m) => m.status?.value && m.status.value !== 'unloaded')
		.map((m) => m.id);
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
async function waitUntilIdle(root: string, model: string, signal?: AbortSignal): Promise<boolean> {
	const deadline = Date.now() + BUSY_WAIT_MS;
	for (;;) {
		const slots = await getJson<Array<{ is_processing?: boolean }>>(
			`${root}/slots?model=${encodeURIComponent(model)}`,
			signal,
		);
		if (!slots.some((s) => s.is_processing)) return true;
		if (Date.now() > deadline) return false;
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
	model: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const deadline = Date.now() + UNLOAD_WAIT_MS;
	for (;;) {
		if (!(await loadedModels(root, signal)).includes(model)) return true;
		if (Date.now() > deadline) return false;
		await sleep(POLL_MS, signal);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				reject(new DOMException('Aborted while releasing endpoint', 'AbortError'));
			},
			{ once: true },
		);
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
 */
export async function releaseEndpointResources(
	endpoint: LoadedEndpoint,
	signal?: AbortSignal,
): Promise<void> {
	if (endpoint.release !== 'llama-cpp-router') return;
	const root = managementRootFrom(endpoint.baseUrl);

	try {
		const loaded = await loadedModels(root, signal);
		if (loaded.length === 0) return;

		for (const model of loaded) {
			if (!(await waitUntilIdle(root, model, signal))) {
				if (DEBUG)
					console.debug(`[release] ${endpoint.id}: ${model} still busy, leaving it loaded`);
				continue;
			}
			const res = await fetch(`${root}/models/unload`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model }),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
					: AbortSignal.timeout(30_000),
			});
			if (!res.ok) throw new Error(`POST ${root}/models/unload → HTTP ${res.status}`);
			const gone = await waitUntilUnloaded(root, model, signal);
			if (DEBUG) {
				console.debug(
					`[release] ${endpoint.id}: ${model} ${gone ? 'unloaded' : 'did not unload in time'}`,
				);
			}
		}
	} catch (e) {
		if (e instanceof Error && e.name === 'AbortError') throw e;
		console.warn(
			`[release] ${endpoint.id}: could not free the shared resource: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}
