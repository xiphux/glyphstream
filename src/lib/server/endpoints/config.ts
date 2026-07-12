import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '$env/dynamic/private';
import { parse as parseToml } from 'smol-toml';
import { configPath } from '../env';
import { parseModelId } from './model-id';
import { normalizeStyle, PROMPT_STYLES } from '../streaming/prompt-styles';
import { normalizeVideoStyle, VIDEO_PROMPT_STYLES } from '../streaming/prompt-styles-video';

/**
 * Canonicalize a prompt-style string against BOTH the image and video style
 * sets, image-first. Config is keyed by upstream model id and can't know the
 * model's kind at load time, so this is used to VALIDATE a value (non-null =
 * a known style in some medium), not to pick the final key for `model_prompt_styles`.
 *
 * Do NOT store this result for a per-model style: a few loose aliases (`structured`,
 * `narrative`, `prose`) are valid in both mediums but canonicalize DIFFERENTLY
 * (image `json`/`natural-language` vs video `structured-cinematic`/`cinematic-prose`),
 * and image wins here — so canonicalizing at load would silently downgrade a video
 * model's `structured` to `json`, which then resolves to null (clarify-only) at
 * kind-time. Store the raw alias instead and let `models.ts` normalize it against
 * the model's own kind. This function's canonical output is only safe where the key
 * is medium-unambiguous — the `style_instructions` override table, whose keys the
 * enhancer looks up by the already-resolved canonical style.
 */
function normalizeAnyStyle(raw: unknown): string | null {
	return normalizeStyle(raw) ?? normalizeVideoStyle(raw);
}

/** All known style keys, for operator-facing "one of …" error messages. */
const ALL_PROMPT_STYLES = [...PROMPT_STYLES, ...VIDEO_PROMPT_STYLES];

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
	model_prompt_styles?: unknown;
	model_prompt_hints?: unknown;
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
	/**
	 * Per-model prompt-style overrides for image/video models, keyed by the
	 * **upstream** model id (same convention as {@link modelContextWindows}).
	 * Each value is the operator's RAW style string (an image {@link PromptStyle}
	 * or a video style, or a loose alias of either) — the prompt FORMAT the
	 * enhancer should rewrite into for that model. Stored un-canonicalized on
	 * purpose: `normalizeUpstreamModel` normalizes it against the model's own
	 * kind, so a cross-medium alias resolves correctly there (canonicalizing at
	 * load can't see the kind and would mis-pick — see `normalizeAnyStyle`).
	 * Wins over the upstream `prompt_style` field. Empty `{}` when the
	 * `model_prompt_styles` table is absent. Validated as a known style at load.
	 */
	modelPromptStyles: Record<string, string>;
	/**
	 * Per-model freeform prompt hints for image/video models, keyed by upstream
	 * model id. Appended to the enhancer's style instruction to carry per-model
	 * nuance (a quality-tag prefix, a length cap, an audio-cue reminder, …). Wins
	 * over the upstream `prompt_hint` field. Empty `{}` when the
	 * `model_prompt_hints` table is absent.
	 */
	modelPromptHints: Record<string, string>;
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

export interface LoadedTaskModelConfig {
	/** "endpoint_id::upstream_model_id". */
	model: string;
	/** Whether this task model is trusted with Private chat content. When true,
	 *  Private chats may still be auto-titled by it (the first exchange is sent to
	 *  it); when false (the default, and the only option for the bare-string form),
	 *  a Private chat keeps its local first-line fallback title. Set it only if the
	 *  task model runs somewhere you trust with private content (e.g. a local
	 *  llama.cpp). */
	private: boolean;
}

/**
 * Read the `task_model` setting from config.toml, if present. Accepts two forms:
 *
 *   - a bare string:  `task_model = "endpoint::model"`  → `{ model, private: false }`
 *   - a table:        `[task_model]` with `model = "…"` and optional `private = true`
 *
 * The table form is preferred — a `[table]` header can sit anywhere in the file,
 * unlike the bare key which must precede every other table header. Returns null
 * when the field is absent. Validates only *type and shape* (the model must be a
 * non-empty `id::id` string); it does NOT verify the referenced endpoint exists —
 * that resolution happens at use-time so a typo doesn't crash app boot.
 */
export function loadTaskModelConfig(path = configPath()): LoadedTaskModelConfig | null {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.task_model;
	if (raw === undefined || raw === null) return null;

	// Back-compat: the original bare-string form is "not trusted for private".
	if (typeof raw === 'string') {
		if (raw.length === 0 || parseModelId(raw) === null) {
			throw new ConfigError(
				`'task_model' "${raw}" in ${absolutePath} must be of the form "endpoint_id::model_id"`,
			);
		}
		return { model: raw, private: false };
	}

	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ConfigError(
			`'task_model' in ${absolutePath} must be a string "endpoint_id::model_id" or a [task_model] table`,
		);
	}
	const block = raw as Record<string, unknown>;
	const at = `[task_model] in ${absolutePath}`;
	const model = requireString(block.model, 'model', at);
	if (parseModelId(model) === null) {
		throw new ConfigError(`'model' in ${at} must be of the form "endpoint_id::model_id"`);
	}
	const isPrivate =
		block.private === undefined ? false : requireBoolean(block.private, 'private', at);
	return { model, private: isPrivate };
}

/** The task model's `endpoint::model` string (from either config form), or null. */
export function loadTaskModel(path = configPath()): string | null {
	return loadTaskModelConfig(path)?.model ?? null;
}

/** Default token cap for one enhancement call. Sized to fit a *structured JSON*
 *  prompt (Ideogram-style: a description + a per-element compositional array +
 *  a color palette), which is far longer than a booru tag list or a paragraph —
 *  the shorter styles stop well before this, so the higher cap costs them
 *  nothing (it's a ceiling, not a target). Still bounded so a runaway enhancer
 *  can't generate endlessly; the per-request timeout backstops it too. */
export const DEFAULT_IMAGE_ENHANCEMENT_MAX_TOKENS = 1000;
/** Default sampling temperature for the enhancer — some creative latitude for
 *  expanding a vague prompt, but not so high it drifts off the subject. */
export const DEFAULT_IMAGE_ENHANCEMENT_TEMPERATURE = 0.7;

/**
 * The optional `[image_enhancement]` block — the model + knobs for the
 * image-prompt-enhancement pass (rewrites an image prompt into the target
 * model's preferred style before generation). Returns null when the section is
 * absent, in which case enhancement is disabled (the relay passes prompts
 * through verbatim).
 *
 * - `model`: required, `"endpoint_id::model_id"`. Like `task_model` and
 *   `[embeddings]`, the referenced endpoint is NOT verified at load time — a
 *   typo/removed endpoint silently disables enhancement at use-time rather than
 *   crashing boot (see `getImageEnhancerModel`).
 * - `max_tokens` / `temperature`: optional sampling overrides.
 * - `[image_enhancement.style_instructions]`: optional per-style instruction
 *   overrides, keyed by canonical style key, letting an operator retune the
 *   built-in `STYLE_INSTRUCTIONS` wording without a code change. Unknown style
 *   keys are rejected.
 */
export interface LoadedImageEnhancementConfig {
	model: string;
	maxTokens: number;
	temperature: number;
	styleInstructionOverrides: Record<string, string>;
}

export function loadImageEnhancementConfig(
	path = configPath(),
): LoadedImageEnhancementConfig | null {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.image_enhancement;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ConfigError(`'[image_enhancement]' in ${absolutePath} must be a TOML table`);
	}
	const block = raw as Record<string, unknown>;
	const at = `[image_enhancement] in ${absolutePath}`;

	const model = requireString(block.model, 'model', at);
	if (parseModelId(model) === null) {
		throw new ConfigError(`${at}: model "${model}" must be of the form "endpoint_id::model_id"`);
	}

	const maxTokens =
		block.max_tokens === undefined
			? DEFAULT_IMAGE_ENHANCEMENT_MAX_TOKENS
			: requireNumber(block.max_tokens, 'max_tokens', at, { min: 1 });
	if (!Number.isInteger(maxTokens)) {
		throw new ConfigError(`${at}: 'max_tokens' must be a whole number`);
	}

	const temperature =
		block.temperature === undefined
			? DEFAULT_IMAGE_ENHANCEMENT_TEMPERATURE
			: requireNumber(block.temperature, 'temperature', at, { min: 0, max: 2 });

	const styleInstructionOverrides: Record<string, string> = {};
	if (block.style_instructions !== undefined) {
		const tbl = block.style_instructions;
		if (typeof tbl !== 'object' || tbl === null || Array.isArray(tbl)) {
			throw new ConfigError(
				`${at}: 'style_instructions' must be a table of "style" = instruction pairs`,
			);
		}
		for (const [style, v] of Object.entries(tbl)) {
			const canonical = normalizeAnyStyle(style);
			if (canonical === null) {
				throw new ConfigError(
					`${at}: style_instructions."${style}" is not a known prompt style (one of ${ALL_PROMPT_STYLES.join(', ')})`,
				);
			}
			styleInstructionOverrides[canonical] = requireString(v, `style_instructions."${style}"`, at);
		}
	}

	return { model, maxTokens, temperature, styleInstructionOverrides };
}

/** Default token cap for one memory-consolidation call — a few merge/reword ops
 *  with rewritten content fit well under this; it's a ceiling, and the
 *  per-request timeout backstops a runaway. */
export const DEFAULT_MEMORY_MODEL_MAX_TOKENS = 2000;
/** Low temperature — consolidation is careful bookkeeping, not creative writing. */
export const DEFAULT_MEMORY_MODEL_TEMPERATURE = 0.2;
/**
 * Default size of the conversation-topics map (characters). It rides in the
 * system prompt on every personalization-on turn, so it's a permanent per-turn
 * token cost (~2500 chars ≈ ~600 tokens) — hence a bounded signpost the model
 * uses to decide what to `search_conversations` for, NOT a log of what was said.
 * Raise it if the map goes thin as the corpus grows; the tradeoff is paid on
 * every message, not just the ones that need it.
 */
export const DEFAULT_MEMORY_OVERVIEW_MAX_CHARS = 2500;

/**
 * The optional `[memory_model]` block — the capable model + schedule for the
 * phase-4 memory-consolidation ("dreaming") worker. Returns null when absent, in
 * which case dreaming is disabled (`getMemoryModel` → null → the worker no-ops).
 *
 * - `model`: required, `"endpoint_id::model_id"`. Like the other model slots the
 *   endpoint is NOT verified at load time — a typo silently disables dreaming at
 *   use-time rather than crashing boot (see `getMemoryModel`).
 * - `max_tokens` / `temperature`: optional sampling overrides.
 * - `active_hours`: optional `"HH:MM-HH:MM"` quiet-hours window (24-hour;
 *   overnight wrap allowed, e.g. `"22:00-06:00"`). Empty = always open.
 * - `timezone`: optional IANA zone the window is read in (default `"UTC"`).
 * - `overview_max_chars`: optional size of the conversation-topics map (see
 *   {@link DEFAULT_MEMORY_OVERVIEW_MAX_CHARS}).
 */
export interface LoadedMemoryModelConfig {
	model: string;
	maxTokens: number;
	temperature: number;
	activeHours: string;
	timezone: string;
	overviewMaxChars: number;
}

export function loadMemoryModelConfig(path = configPath()): LoadedMemoryModelConfig | null {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.memory_model;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ConfigError(`'[memory_model]' in ${absolutePath} must be a TOML table`);
	}
	const block = raw as Record<string, unknown>;
	const at = `[memory_model] in ${absolutePath}`;

	const model = requireString(block.model, 'model', at);
	if (parseModelId(model) === null) {
		throw new ConfigError(`${at}: model "${model}" must be of the form "endpoint_id::model_id"`);
	}

	const maxTokens =
		block.max_tokens === undefined
			? DEFAULT_MEMORY_MODEL_MAX_TOKENS
			: requireNumber(block.max_tokens, 'max_tokens', at, { min: 1 });
	if (!Number.isInteger(maxTokens)) {
		throw new ConfigError(`${at}: 'max_tokens' must be a whole number`);
	}

	const temperature =
		block.temperature === undefined
			? DEFAULT_MEMORY_MODEL_TEMPERATURE
			: requireNumber(block.temperature, 'temperature', at, { min: 0, max: 2 });

	let activeHours = '';
	if (block.active_hours !== undefined) {
		activeHours = requireString(block.active_hours, 'active_hours', at);
		if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(activeHours)) {
			throw new ConfigError(
				`${at}: 'active_hours' must be "HH:MM-HH:MM" (24-hour), e.g. "02:00-06:00"`,
			);
		}
		for (const hhmm of activeHours.split('-')) {
			const [h, m] = hhmm.split(':').map(Number);
			if (h > 23 || m > 59) {
				throw new ConfigError(`${at}: 'active_hours' has an out-of-range time "${hhmm}"`);
			}
		}
	}

	let timezone = 'UTC';
	if (block.timezone !== undefined) {
		timezone = requireString(block.timezone, 'timezone', at);
		try {
			// Intl.DateTimeFormat throws RangeError on an unknown zone — the same
			// zero-dependency validation the clock tool uses.
			new Intl.DateTimeFormat('en-US', { timeZone: timezone });
		} catch {
			throw new ConfigError(
				`${at}: 'timezone' "${timezone}" is not a known IANA timezone (e.g. "America/New_York" or "UTC")`,
			);
		}
	}

	// Floored well above zero: below a few hundred chars the map can't name enough
	// threads to be a useful search signpost, and the model would be asked for a
	// length it can't meaningfully hit.
	const overviewMaxChars =
		block.overview_max_chars === undefined
			? DEFAULT_MEMORY_OVERVIEW_MAX_CHARS
			: requireNumber(block.overview_max_chars, 'overview_max_chars', at, { min: 500 });
	if (!Number.isInteger(overviewMaxChars)) {
		throw new ConfigError(`${at}: 'overview_max_chars' must be a whole number`);
	}

	return { model, maxTokens, temperature, activeHours, timezone, overviewMaxChars };
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
 * Longest edge, in pixels, an image is downscaled to before being inlined into a
 * chat request. 1568 is the largest size that's still useful to current vision
 * models — above it they downscale internally anyway, so the extra pixels buy
 * nothing and cost real bytes in every turn of the conversation. Small enough to
 * cut a 4K screenshot by ~85%, large enough to keep screenshot text legible,
 * which is the quality floor that actually matters here.
 */
export const DEFAULT_VISION_MAX_IMAGE_DIM = 1568;

/** JPEG quality for the inlined variant. 82 is past the point where vision
 *  models measurably care, and well under the size cliff at 90+. */
export const DEFAULT_VISION_IMAGE_QUALITY = 82;

export interface VisionConfig {
	maxImageDim: number;
	imageQuality: number;
}

/**
 * Read the optional top-level `[vision]` block. Governs the downscaled variant
 * inlined into chat requests — NOT what's stored: the original upload is kept
 * untouched, and image-to-image still dispatches full-resolution bytes.
 *
 * Set `max_image_dim = 0` to disable downscaling and inline originals (the old
 * behavior) — useful if a model genuinely needs full resolution, at the cost of
 * re-sending those bytes on every turn.
 */
export function loadVisionConfig(path = configPath()): VisionConfig {
	const { parsed, absolutePath } = readAndParse(path);
	const vision = parsed.vision;
	const defaults: VisionConfig = {
		maxImageDim: DEFAULT_VISION_MAX_IMAGE_DIM,
		imageQuality: DEFAULT_VISION_IMAGE_QUALITY,
	};
	if (vision === undefined || vision === null) return defaults;
	if (typeof vision !== 'object' || Array.isArray(vision)) {
		throw new ConfigError(`'[vision]' in ${absolutePath} must be a TOML table`);
	}
	const block = vision as Record<string, unknown>;

	const maxImageDim = block.max_image_dim;
	if (maxImageDim !== undefined && maxImageDim !== null) {
		if (typeof maxImageDim !== 'number' || !Number.isInteger(maxImageDim) || maxImageDim < 0) {
			throw new ConfigError(
				`'[vision] max_image_dim' in ${absolutePath} must be a non-negative integer (0 disables downscaling)`,
			);
		}
		defaults.maxImageDim = maxImageDim;
	}

	const imageQuality = block.image_quality;
	if (imageQuality !== undefined && imageQuality !== null) {
		if (
			typeof imageQuality !== 'number' ||
			!Number.isInteger(imageQuality) ||
			imageQuality < 1 ||
			imageQuality > 100
		) {
			throw new ConfigError(
				`'[vision] image_quality' in ${absolutePath} must be an integer between 1 and 100`,
			);
		}
		defaults.imageQuality = imageQuality;
	}

	return defaults;
}

let visionConfigCache: VisionConfig | undefined;

/** Memoized {@link loadVisionConfig} for the per-request hot path. */
export function getVisionConfig(): VisionConfig {
	if (visionConfigCache === undefined) visionConfigCache = loadVisionConfig();
	return visionConfigCache;
}

/** Test hook: clear the memoized vision config so the next call re-reads. */
export function _resetVisionConfigCacheForTests(): void {
	visionConfigCache = undefined;
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

	const modelPromptStyles: Record<string, string> = {};
	if (raw.model_prompt_styles !== undefined) {
		const tbl = raw.model_prompt_styles;
		if (typeof tbl !== 'object' || tbl === null || Array.isArray(tbl)) {
			throw new ConfigError(
				`${at}: 'model_prompt_styles' must be a table of "model-id" = prompt-style pairs`,
			);
		}
		for (const [modelId, v] of Object.entries(tbl)) {
			const field = `model_prompt_styles."${modelId}"`;
			const s = requireString(v, field, at);
			// Validate the value is a known image OR video style so an operator
			// typo surfaces at boot — but store the RAW string, NOT the canonical.
			// A few aliases (structured/narrative/prose) canonicalize differently
			// per medium, and this loader can't see the model's kind; `models.ts`
			// normalizes against the model's own kind, which resolves the alias
			// correctly (e.g. `structured` → structured-cinematic for a video
			// model). Canonicalizing here would collapse it to the image key and
			// silently downgrade the video model to clarify-only.
			if (normalizeAnyStyle(s) === null) {
				throw new ConfigError(
					`${at}: '${field}' = "${s}" is not a known prompt style (one of ${ALL_PROMPT_STYLES.join(', ')})`,
				);
			}
			modelPromptStyles[modelId] = s;
		}
	}

	const modelPromptHints: Record<string, string> = {};
	if (raw.model_prompt_hints !== undefined) {
		const tbl = raw.model_prompt_hints;
		if (typeof tbl !== 'object' || tbl === null || Array.isArray(tbl)) {
			throw new ConfigError(
				`${at}: 'model_prompt_hints' must be a table of "model-id" = hint-string pairs`,
			);
		}
		for (const [modelId, v] of Object.entries(tbl)) {
			const field = `model_prompt_hints."${modelId}"`;
			modelPromptHints[modelId] = requireString(v, field, at);
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
		modelPromptStyles,
		modelPromptHints,
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
