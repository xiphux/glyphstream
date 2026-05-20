import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '$env/dynamic/private';
import { parse as parseToml } from 'smol-toml';
import { configPath } from '../env';

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
	const sepIdx = raw.indexOf('::');
	if (sepIdx <= 0 || sepIdx === raw.length - 2) {
		throw new ConfigError(
			`'task_model' "${raw}" in ${absolutePath} must be of the form "endpoint_id::model_id"`
		);
	}
	return raw;
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

	return { id, displayName, baseUrl, apiKey, requestTimeoutSeconds, providerQuirk, groupBy };
}

function requireString(v: unknown, field: string, at: string): string {
	if (typeof v !== 'string' || v.length === 0) {
		throw new ConfigError(`${at}: required field '${field}' must be a non-empty string`);
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
