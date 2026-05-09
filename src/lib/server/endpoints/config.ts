import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { configPath } from '../env';

export type ProviderQuirk = 'passthrough' | 'deepseek-r1' | 'openai-o-series' | 'openrouter';

const VALID_QUIRKS: readonly ProviderQuirk[] = [
	'passthrough',
	'deepseek-r1',
	'openai-o-series',
	'openrouter'
];

/** As declared in config.toml — keys snake_case, before env-var resolution. */
interface RawEndpoint {
	id?: unknown;
	display_name?: unknown;
	base_url?: unknown;
	api_key_env?: unknown;
	request_timeout_seconds?: unknown;
	provider_quirk?: unknown;
}

/** After validation + env-var resolution. */
export interface LoadedEndpoint {
	id: string;
	displayName: string;
	baseUrl: string;
	apiKey: string | null;
	requestTimeoutSeconds: number;
	providerQuirk: ProviderQuirk;
}

export class ConfigError extends Error {}

/** Read + parse + validate config.toml. Throws ConfigError on any problem. */
export function loadEndpoints(path = configPath()): LoadedEndpoint[] {
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

	const endpointsRaw = (parsed as { endpoints?: unknown }).endpoints;
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
		const envValue = process.env[envName];
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

	return { id, displayName, baseUrl, apiKey, requestTimeoutSeconds, providerQuirk };
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
