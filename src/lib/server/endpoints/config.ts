import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '$env/dynamic/private';
import { parse as parseToml } from 'smol-toml';
import { configPath } from '../env';
import { parseModelId } from './model-id';

export type ProviderQuirk = 'passthrough' | 'deepseek-r1' | 'openai-o-series' | 'openrouter';

const VALID_QUIRKS: readonly ProviderQuirk[] = [
	'passthrough',
	'deepseek-r1',
	'openai-o-series',
	'openrouter',
];

/**
 * How the model picker labels the group an endpoint's models appear under.
 *
 * - `endpoint` (default): one group per [[endpoints]] block, labeled with
 *   `display_name`. Right for direct upstreams (Groq, llama-server, OpenAI).
 * - `owned_by`: read each model's `owned_by` field and bucket by that —
 *   useful for aggregating proxies (e.g. openai-api-bridge) where one
 *   endpoint exposes models from many real providers and you'd rather see
 *   "OpenRouter / Venice / ImageRouter / ComfyUI" than one giant "Bridge"
 *   group. Models without `owned_by` fall back to the endpoint's group.
 */
export type ProviderGrouping = 'endpoint' | 'owned_by';

const VALID_GROUPINGS: readonly ProviderGrouping[] = ['endpoint', 'owned_by'];

/** As declared in config.toml — keys snake_case, before env-var resolution. */
interface RawEndpoint {
	id?: unknown;
	display_name?: unknown;
	base_url?: unknown;
	api_key_env?: unknown;
	request_timeout_seconds?: unknown;
	provider_quirk?: unknown;
	group_by?: unknown;
	supports_tools?: unknown;
	max_concurrent?: unknown;
	context_window?: unknown;
	model_context_windows?: unknown;
}

/** After validation + env-var resolution. */
export interface LoadedEndpoint {
	id: string;
	displayName: string;
	baseUrl: string;
	apiKey: string | null;
	requestTimeoutSeconds: number;
	providerQuirk: ProviderQuirk;
	groupBy: ProviderGrouping;
	/**
	 * Endpoint-level fallback for native tool-calling support. The
	 * OpenAI spec's `/v1/models` row doesn't carry capability flags,
	 * so for vendors that don't surface a per-model signal (raw OpenAI,
	 * Anthropic, etc.) we let operators flip this for the whole
	 * endpoint. The actual decision at request time prefers the
	 * upstream-reported per-model signal when present
	 * (`ModelEntry.supportsTools` resolves both layers).
	 */
	supportsTools: boolean;
	/**
	 * Max generations allowed to run against this endpoint at once. Extra
	 * requests queue (FIFO) until a slot frees — the slot is held for the
	 * whole generation, so a single-GPU local backend (llama-server,
	 * ComfyUI bridge) that can only hold one model in VRAM serializes
	 * instead of thrashing. Defaults to `DEFAULT_MAX_CONCURRENT` when
	 * `max_concurrent` is absent — a friendly cap so a large multi-model
	 * fan-out trickles instead of blasting the upstream all at once. Set it
	 * to 1 for a single-GPU local backend, or high (up to 1024) for an
	 * endpoint that handles its own concurrency.
	 */
	maxConcurrent: number;
	/**
	 * Endpoint-level fallback for a model's context-window size, in tokens.
	 * The OpenAI `/v1/models` row carries no context-size field, so for
	 * vendors that surface nothing per-model (raw OpenAI, Groq, …) operators
	 * can state a blanket value here. The actual decision prefers the
	 * upstream-reported per-model size when present (llama.cpp's `meta.n_ctx`
	 * / router `--ctx-size`, vLLM's `max_model_len`, a bridge-normalized
	 * `context_window`) — see `extractContextWindow`. Null when absent.
	 */
	contextWindow: number | null;
	/**
	 * Per-model context-window overrides, keyed by the *upstream* model id —
	 * the id as the upstream's `/v1/models` reports it, before GlyphStream's
	 * `endpoint::` prefix (for an aggregating bridge that's the provider-
	 * prefixed id, e.g. `llama/Gemma4-26B`). For a llama-server in router mode each
	 * model can carry its own `--ctx-size`, so a single endpoint-level
	 * {@link contextWindow} is too coarse; this lets operators state the size
	 * per model. An entry here is the operator's explicit per-model statement
	 * and wins over auto-detection (see `normalizeUpstreamModel`). Empty `{}`
	 * when the `model_context_windows` table is absent.
	 */
	modelContextWindows: Record<string, number>;
}

/**
 * Default per-endpoint concurrency when `max_concurrent` is omitted. Not
 * unlimited: a multi-model fan-out (or several busy conversations) shouldn't
 * fire an unbounded number of simultaneous upstream requests. Operators tune
 * per endpoint — 1 for single-GPU local backends, higher for hosted APIs.
 */
export const DEFAULT_MAX_CONCURRENT = 4;

export class ConfigError extends Error {}

function readAndParse(path: string): { parsed: Record<string, unknown>; absolutePath: string } {
	const absolutePath = resolve(path);
	let raw: string;
	try {
		raw = readFileSync(absolutePath, 'utf8');
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new ConfigError(`Could not read config file at ${absolutePath}: ${cause}`);
	}

	let parsed: unknown;
	try {
		parsed = parseToml(raw);
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new ConfigError(`Failed to parse TOML at ${absolutePath}: ${cause}`);
	}

	if (typeof parsed !== 'object' || parsed === null) {
		throw new ConfigError(`Top-level of ${absolutePath} must be a TOML table`);
	}

	return { parsed: parsed as Record<string, unknown>, absolutePath };
}

/** Read + parse + validate config.toml. Throws ConfigError on any problem. */
export function loadEndpoints(path = configPath()): LoadedEndpoint[] {
	const { parsed, absolutePath } = readAndParse(path);

	const endpointsRaw = parsed.endpoints;
	if (endpointsRaw === undefined) {
		// Empty config is allowed — no endpoints yet, /api/models returns []
		return [];
	}
	if (!Array.isArray(endpointsRaw)) {
		throw new ConfigError(
			`'endpoints' in ${absolutePath} must be an array of [[endpoints]] tables`,
		);
	}

	const endpoints: LoadedEndpoint[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < endpointsRaw.length; i++) {
		const ep = validateEndpoint(endpointsRaw[i] as RawEndpoint, i, absolutePath);
		if (seenIds.has(ep.id)) {
			throw new ConfigError(
				`Duplicate endpoint id "${ep.id}" in ${absolutePath} — every endpoint must be unique`,
			);
		}
		seenIds.add(ep.id);
		endpoints.push(ep);
	}
	return endpoints;
}

/**
 * Read the `[notifications]` block from config.toml, if present. Returns
 * null when the section is absent — push features then soft-disable
 * (subscribe endpoint returns 503, notifyConversationComplete short-
 * circuits). This keeps a clone with no VAPID setup bootable; the UI
 * surfaces a hint instead of crashing at boot.
 *
 * - `vapid_public`: base64url-encoded public key. Plaintext (no secret).
 * - `vapid_private_env`: name of the env var holding the private key.
 *   Follows the `*_env` convention — the secret is never in config.toml.
 * - `vapid_subject`: a `mailto:` URL the Web Push spec requires for the
 *   VAPID JWT's `sub` claim. Push services may contact this address if
 *   our pushes misbehave.
 */
export interface LoadedNotificationsConfig {
	vapidPublic: string;
	vapidPrivate: string;
	vapidSubject: string;
}

export function loadNotificationsConfig(path = configPath()): LoadedNotificationsConfig | null {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.notifications;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ConfigError(`'[notifications]' in ${absolutePath} must be a TOML table`);
	}
	const block = raw as Record<string, unknown>;
	const at = `[notifications] in ${absolutePath}`;

	const vapidPublic = requireString(block.vapid_public, 'vapid_public', at);
	const vapidSubject = requireString(block.vapid_subject, 'vapid_subject', at);
	if (!/^mailto:.+@.+$/.test(vapidSubject) && !/^https?:\/\//.test(vapidSubject)) {
		throw new ConfigError(
			`${at}: vapid_subject "${vapidSubject}" must be a mailto: or http(s):// URL`,
		);
	}

	const envName = requireString(block.vapid_private_env, 'vapid_private_env', at);
	const envValue = env[envName];
	if (!envValue) {
		throw new ConfigError(
			`${at}: vapid_private_env="${envName}" but env var ${envName} is unset or empty`,
		);
	}

	return { vapidPublic, vapidPrivate: envValue, vapidSubject };
}

/**
 * Read the top-level `task_model` setting from config.toml, if present.
 * Returns the raw "endpoint_id::upstream_model_id" string when set, or
 * null when the field is absent. Validates only the field's *type and
 * shape* (must be a non-empty string of the form `id::id`); it does NOT
 * verify the referenced endpoint actually exists in the registry —
 * that resolution happens at use-time in the task-model resolver so a
 * typo in `task_model` doesn't crash app boot.
 */
export function loadTaskModel(path = configPath()): string | null {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.task_model;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'string' || raw.length === 0) {
		throw new ConfigError(
			`'task_model' in ${absolutePath} must be a non-empty string of the form "endpoint_id::model_id"`,
		);
	}
	if (parseModelId(raw) === null) {
		throw new ConfigError(
			`'task_model' "${raw}" in ${absolutePath} must be of the form "endpoint_id::model_id"`,
		);
	}
	return raw;
}

/** Default hard cap on upstream round-trips within a single turn's tool loop. */
export const DEFAULT_MAX_TOOL_LOOP_ITERATIONS = 8;

/**
 * Read `[tools] max_tool_loop_iterations` — the hard cap on upstream
 * round-trips in one turn's tool loop (a runaway-`tool_calls` backstop, not a
 * normal limit). Bumped from the original 5 because deferred-tool search adds a
 * round-trip (search, then call). Defaults to {@link DEFAULT_MAX_TOOL_LOOP_ITERATIONS};
 * must be a positive integer.
 */
export function loadMaxToolLoopIterations(path = configPath()): number {
	const { parsed, absolutePath } = readAndParse(path);
	const tools = parsed.tools;
	if (tools === undefined || tools === null) return DEFAULT_MAX_TOOL_LOOP_ITERATIONS;
	if (typeof tools !== 'object' || Array.isArray(tools)) {
		throw new ConfigError(`'[tools]' in ${absolutePath} must be a TOML table`);
	}
	const raw = (tools as Record<string, unknown>).max_tool_loop_iterations;
	if (raw === undefined || raw === null) return DEFAULT_MAX_TOOL_LOOP_ITERATIONS;
	if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
		throw new ConfigError(
			`'[tools] max_tool_loop_iterations' in ${absolutePath} must be a positive integer`,
		);
	}
	return raw;
}

let maxToolLoopIterationsCache: number | undefined;

/** Memoized {@link loadMaxToolLoopIterations} for the per-request hot path
 *  (config.toml doesn't change at runtime). */
export function getMaxToolLoopIterations(): number {
	if (maxToolLoopIterationsCache === undefined) {
		maxToolLoopIterationsCache = loadMaxToolLoopIterations();
	}
	return maxToolLoopIterationsCache;
}

/** Test hook: clear the memoized iteration cap so the next call re-reads. */
export function _resetMaxToolLoopIterationsCacheForTests(): void {
	maxToolLoopIterationsCache = undefined;
}

/**
 * Read the top-level `[search]` block from config.toml, if present.
 * Backs the `web_search` tool. Returns null when the section is absent,
 * which the tool reads via `isAvailable()` to hide itself from the
 * model.
 *
 * - `url`: SearxNG base URL. Trailing slashes are stripped so callers
 *   can `new URL('/search', cfg.url)` regardless of how it was written.
 * - `api_key_env`: optional. Name of an env var holding the auth header
 *   value. Follows the `*_env` secrets convention.
 * - `timeout_seconds`: optional, defaults to 10.
 *
 * Section is named for the capability, not the implementation — a
 * future swap to Brave / Tavily / Kagi can land without breaking
 * existing configs.
 */
export interface LoadedSearchConfig {
	url: string;
	apiKey: string | null;
	timeoutSeconds: number;
}

export function loadSearchConfig(path = configPath()): LoadedSearchConfig | null {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.search;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ConfigError(`'[search]' in ${absolutePath} must be a TOML table`);
	}
	const block = raw as Record<string, unknown>;
	const at = `[search] in ${absolutePath}`;

	const url = requireString(block.url, 'url', at).replace(/\/+$/, '');
	if (!/^https?:\/\//.test(url)) {
		throw new ConfigError(`${at}: url must start with http:// or https://`);
	}

	let apiKey: string | null = null;
	if (block.api_key_env !== undefined) {
		const envName = requireString(block.api_key_env, 'api_key_env', at);
		const envValue = env[envName];
		if (!envValue) {
			throw new ConfigError(
				`${at}: api_key_env="${envName}" but env var ${envName} is unset or empty`,
			);
		}
		apiKey = envValue;
	}

	const timeoutSeconds =
		block.timeout_seconds === undefined
			? 10
			: requireNumber(block.timeout_seconds, 'timeout_seconds', at, { min: 1 });

	return { url, apiKey, timeoutSeconds };
}

/** Default cosine floor for the gallery search semantic leg. Single source of
 *  truth so the loader default and any in-code fallback can't diverge. */
export const DEFAULT_GALLERY_SEARCH_MIN_SIMILARITY = 0.5;

export interface LoadedEmbeddingsConfig {
	/** id of the [[endpoints]] block that hosts the embedding model. */
	endpointId: string;
	/** upstream model id passed as `model` to /v1/embeddings. */
	modelId: string;
	timeoutSeconds: number;
	/**
	 * Optional task-instruction prefixes. Some embedding models (nomic-embed,
	 * e5, bge, gte) require asymmetric prefixes — "search_query: " on the query
	 * and "search_document: " on the passages — to hit their trained accuracy.
	 * OpenAI/Cohere-style models must NOT get them, so both default to empty.
	 */
	queryPrefix: string;
	documentPrefix: string;
	/**
	 * The model's maximum input sequence length, in tokens. Each text we embed
	 * is truncated to fit (an input over the limit makes the backend 500). The
	 * default 512 is the conservative small-model floor (nomic-embed, e5, bge);
	 * raise it to the real value for large-context models (e.g. 8192) so long
	 * chunks embed whole instead of being clipped.
	 */
	maxInputTokens: number;
	/**
	 * Cosine-similarity floor for the gallery prompt search's semantic leg: a
	 * dense neighbour must score at least this to be surfaced, so genuine
	 * synonyms appear but unrelated prompts don't pad the results. Model-
	 * dependent (cosine scales differ per model + prefix) — raise it for fewer,
	 * tighter matches, lower it for more recall. Default 0.5. Only gallery search
	 * reads it; the other embedding consumers (fetch_url, recall_memory) ignore it.
	 */
	gallerySearchMinSimilarity: number;
}

/**
 * Parse the optional top-level `[embeddings]` block — the embedding model used
 * for hybrid retrieval (fetch_url relevance selection; later recall_memory).
 *
 * Unlike `[search]`, this block carries no secret: baseUrl + apiKey come from
 * the referenced endpoint. And like `loadTaskModel`, it does NOT verify the
 * endpoint id resolves at load time — a typo shouldn't crash boot. The
 * consumer looks the endpoint up at use-time and degrades to lexical-only
 * retrieval when it's missing, so a stale id silently disables embeddings
 * rather than erroring.
 */
export function loadEmbeddingsConfig(path = configPath()): LoadedEmbeddingsConfig | null {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.embeddings;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ConfigError(`'[embeddings]' in ${absolutePath} must be a TOML table`);
	}
	const block = raw as Record<string, unknown>;
	const at = `[embeddings] in ${absolutePath}`;

	const endpointId = requireString(block.endpoint_id, 'endpoint_id', at);
	const modelId = requireString(block.model_id, 'model_id', at);
	const timeoutSeconds =
		block.timeout_seconds === undefined
			? 30
			: requireNumber(block.timeout_seconds, 'timeout_seconds', at, { min: 1 });
	const queryPrefix = optionalString(block.query_prefix, 'query_prefix', at);
	const documentPrefix = optionalString(block.document_prefix, 'document_prefix', at);
	const maxInputTokens =
		block.max_input_tokens === undefined
			? 512
			: requireNumber(block.max_input_tokens, 'max_input_tokens', at, { min: 1 });
	const gallerySearchMinSimilarity =
		block.gallery_search_min_similarity === undefined
			? DEFAULT_GALLERY_SEARCH_MIN_SIMILARITY
			: requireNumber(block.gallery_search_min_similarity, 'gallery_search_min_similarity', at, {
					min: 0,
					max: 1,
				});

	return {
		endpointId,
		modelId,
		timeoutSeconds,
		queryPrefix,
		documentPrefix,
		maxInputTokens,
		gallerySearchMinSimilarity,
	};
}

export interface LoadedRerankConfig {
	/** id of the [[endpoints]] block that hosts the rerank model. */
	endpointId: string;
	/** upstream model id passed as `model` to /rerank. */
	modelId: string;
	timeoutSeconds: number;
	/** How many of the top fused candidates to rerank (cost ceiling). */
	topN: number;
	/** Wire-shape variant; undefined = the Cohere/Jina default. */
	quirk: 'tei' | undefined;
}

/**
 * Parse the optional top-level `[rerank]` block — a cross-encoder rerank model
 * that reorders the hybrid-retrieved chunks on over-budget `fetch_url` reads.
 *
 * Like `[embeddings]`, it carries no secret (baseUrl + apiKey come from the
 * referenced endpoint) and does NOT verify the endpoint id at load time — a
 * stale id silently disables reranking (the read falls back to the fused
 * BM25/embedding order) rather than crashing boot.
 */
export function loadRerankConfig(path = configPath()): LoadedRerankConfig | null {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.rerank;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ConfigError(`'[rerank]' in ${absolutePath} must be a TOML table`);
	}
	const block = raw as Record<string, unknown>;
	const at = `[rerank] in ${absolutePath}`;

	const endpointId = requireString(block.endpoint_id, 'endpoint_id', at);
	const modelId = requireString(block.model_id, 'model_id', at);
	const timeoutSeconds =
		block.timeout_seconds === undefined
			? 30
			: requireNumber(block.timeout_seconds, 'timeout_seconds', at, { min: 1 });
	const topN = block.top_n === undefined ? 20 : requireNumber(block.top_n, 'top_n', at, { min: 1 });

	let quirk: 'tei' | undefined;
	if (block.quirk !== undefined) {
		const q = requireString(block.quirk, 'quirk', at);
		if (q !== 'tei') {
			throw new ConfigError(`${at}: quirk must be "tei" (the only variant) if present`);
		}
		quirk = q;
	}

	return { endpointId, modelId, timeoutSeconds, topN, quirk };
}

function validateEndpoint(raw: RawEndpoint, index: number, path: string): LoadedEndpoint {
	const at = `[[endpoints]] #${index} in ${path}`;

	const id = requireString(raw.id, 'id', at);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
		throw new ConfigError(
			`${at}: id "${id}" must be 1-64 chars, lowercase alphanumeric or dash, starting with alphanumeric`,
		);
	}

	const baseUrl = requireString(raw.base_url, 'base_url', at).replace(/\/+$/, '');
	if (!/^https?:\/\//.test(baseUrl)) {
		throw new ConfigError(`${at}: base_url must start with http:// or https://`);
	}

	const displayName =
		raw.display_name === undefined ? id : requireString(raw.display_name, 'display_name', at);

	let apiKey: string | null = null;
	if (raw.api_key_env !== undefined) {
		const envName = requireString(raw.api_key_env, 'api_key_env', at);
		// Read via SvelteKit's $env/dynamic/private so .env values picked up
		// in dev (Vite doesn't populate process.env from .env). In production
		// adapter-node both `env` and process.env reflect the host env.
		const envValue = env[envName];
		if (!envValue) {
			throw new ConfigError(
				`${at}: api_key_env="${envName}" but env var ${envName} is unset or empty`,
			);
		}
		apiKey = envValue;
	}

	const requestTimeoutSeconds =
		raw.request_timeout_seconds === undefined
			? 120
			: requireNumber(raw.request_timeout_seconds, 'request_timeout_seconds', at, { min: 1 });

	let providerQuirk: ProviderQuirk = 'passthrough';
	if (raw.provider_quirk !== undefined) {
		const q = requireString(raw.provider_quirk, 'provider_quirk', at);
		if (!(VALID_QUIRKS as readonly string[]).includes(q)) {
			throw new ConfigError(
				`${at}: provider_quirk "${q}" must be one of ${VALID_QUIRKS.join(', ')}`,
			);
		}
		providerQuirk = q as ProviderQuirk;
	}

	let groupBy: ProviderGrouping = 'endpoint';
	if (raw.group_by !== undefined) {
		const g = requireString(raw.group_by, 'group_by', at);
		if (!(VALID_GROUPINGS as readonly string[]).includes(g)) {
			throw new ConfigError(`${at}: group_by "${g}" must be one of ${VALID_GROUPINGS.join(', ')}`);
		}
		groupBy = g as ProviderGrouping;
	}

	const supportsTools =
		raw.supports_tools === undefined
			? false
			: requireBoolean(raw.supports_tools, 'supports_tools', at);

	let maxConcurrent = DEFAULT_MAX_CONCURRENT;
	if (raw.max_concurrent !== undefined) {
		maxConcurrent = requireNumber(raw.max_concurrent, 'max_concurrent', at, { min: 1, max: 1024 });
		if (!Number.isInteger(maxConcurrent)) {
			throw new ConfigError(`${at}: 'max_concurrent' must be a whole number`);
		}
	}

	let contextWindow: number | null = null;
	if (raw.context_window !== undefined) {
		contextWindow = requireNumber(raw.context_window, 'context_window', at, { min: 1 });
		if (!Number.isInteger(contextWindow)) {
			throw new ConfigError(`${at}: 'context_window' must be a whole number`);
		}
	}

	const modelContextWindows: Record<string, number> = {};
	if (raw.model_context_windows !== undefined) {
		const tbl = raw.model_context_windows;
		if (typeof tbl !== 'object' || tbl === null || Array.isArray(tbl)) {
			throw new ConfigError(
				`${at}: 'model_context_windows' must be a table of "model-id" = context-size pairs`,
			);
		}
		for (const [modelId, v] of Object.entries(tbl)) {
			const field = `model_context_windows."${modelId}"`;
			const n = requireNumber(v, field, at, { min: 1 });
			if (!Number.isInteger(n)) {
				throw new ConfigError(`${at}: '${field}' must be a whole number`);
			}
			modelContextWindows[modelId] = n;
		}
	}

	return {
		id,
		displayName,
		baseUrl,
		apiKey,
		requestTimeoutSeconds,
		providerQuirk,
		groupBy,
		supportsTools,
		maxConcurrent,
		contextWindow,
		modelContextWindows,
	};
}

function requireString(v: unknown, field: string, at: string): string {
	if (typeof v !== 'string' || v.length === 0) {
		throw new ConfigError(`${at}: required field '${field}' must be a non-empty string`);
	}
	return v;
}

/** A string field that may be omitted (→ '') but, if present, must be a string. */
function optionalString(v: unknown, field: string, at: string): string {
	if (v === undefined) return '';
	if (typeof v !== 'string') {
		throw new ConfigError(`${at}: '${field}' must be a string`);
	}
	return v;
}

function requireBoolean(v: unknown, field: string, at: string): boolean {
	if (typeof v !== 'boolean') {
		throw new ConfigError(`${at}: '${field}' must be a boolean (true/false)`);
	}
	return v;
}

function requireNumber(
	v: unknown,
	field: string,
	at: string,
	opts: { min?: number; max?: number } = {},
): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) {
		throw new ConfigError(`${at}: '${field}' must be a number`);
	}
	if (opts.min !== undefined && v < opts.min) {
		throw new ConfigError(`${at}: '${field}' must be >= ${opts.min}`);
	}
	if (opts.max !== undefined && v > opts.max) {
		throw new ConfigError(`${at}: '${field}' must be <= ${opts.max}`);
	}
	return v;
}
