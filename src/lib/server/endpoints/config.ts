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
	'openrouter'
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
}

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
		throw new ConfigError(`'endpoints' in ${absolutePath} must be an array of [[endpoints]] tables`);
	}

	const endpoints: LoadedEndpoint[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < endpointsRaw.length; i++) {
		const ep = validateEndpoint(endpointsRaw[i] as RawEndpoint, i, absolutePath);
		if (seenIds.has(ep.id)) {
			throw new ConfigError(
				`Duplicate endpoint id "${ep.id}" in ${absolutePath} — every endpoint must be unique`
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

export function loadNotificationsConfig(
	path = configPath()
): LoadedNotificationsConfig | null {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.notifications;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ConfigError(
			`'[notifications]' in ${absolutePath} must be a TOML table`
		);
	}
	const block = raw as Record<string, unknown>;
	const at = `[notifications] in ${absolutePath}`;

	const vapidPublic = requireString(block.vapid_public, 'vapid_public', at);
	const vapidSubject = requireString(block.vapid_subject, 'vapid_subject', at);
	if (!/^mailto:.+@.+$/.test(vapidSubject) && !/^https?:\/\//.test(vapidSubject)) {
		throw new ConfigError(
			`${at}: vapid_subject "${vapidSubject}" must be a mailto: or http(s):// URL`
		);
	}

	const envName = requireString(block.vapid_private_env, 'vapid_private_env', at);
	const envValue = env[envName];
	if (!envValue) {
		throw new ConfigError(
			`${at}: vapid_private_env="${envName}" but env var ${envName} is unset or empty`
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
			`'task_model' in ${absolutePath} must be a non-empty string of the form "endpoint_id::model_id"`
		);
	}
	if (parseModelId(raw) === null) {
		throw new ConfigError(
			`'task_model' "${raw}" in ${absolutePath} must be of the form "endpoint_id::model_id"`
		);
	}
	return raw;
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
				`${at}: api_key_env="${envName}" but env var ${envName} is unset or empty`
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

function validateEndpoint(raw: RawEndpoint, index: number, path: string): LoadedEndpoint {
	const at = `[[endpoints]] #${index} in ${path}`;

	const id = requireString(raw.id, 'id', at);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
		throw new ConfigError(
			`${at}: id "${id}" must be 1-64 chars, lowercase alphanumeric or dash, starting with alphanumeric`
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
				`${at}: api_key_env="${envName}" but env var ${envName} is unset or empty`
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
				`${at}: provider_quirk "${q}" must be one of ${VALID_QUIRKS.join(', ')}`
			);
		}
		providerQuirk = q as ProviderQuirk;
	}

	let groupBy: ProviderGrouping = 'endpoint';
	if (raw.group_by !== undefined) {
		const g = requireString(raw.group_by, 'group_by', at);
		if (!(VALID_GROUPINGS as readonly string[]).includes(g)) {
			throw new ConfigError(
				`${at}: group_by "${g}" must be one of ${VALID_GROUPINGS.join(', ')}`
			);
		}
		groupBy = g as ProviderGrouping;
	}

	const supportsTools =
		raw.supports_tools === undefined ? false : requireBoolean(raw.supports_tools, 'supports_tools', at);

	return {
		id,
		displayName,
		baseUrl,
		apiKey,
		requestTimeoutSeconds,
		providerQuirk,
		groupBy,
		supportsTools
	};
}

function requireString(v: unknown, field: string, at: string): string {
	if (typeof v !== 'string' || v.length === 0) {
		throw new ConfigError(`${at}: required field '${field}' must be a non-empty string`);
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
	opts: { min?: number; max?: number } = {}
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
