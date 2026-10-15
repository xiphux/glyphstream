/**
 * Reading `config.toml`: the file itself, and the field validators every
 * block's loader shares (endpoints, MCP servers, the code interpreter).
 *
 * One `ConfigError` for all of them, so a caller that degrades on a broken
 * config (the model list, the endpoint status page) catches every block's
 * failure, not just the endpoints'.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

/**
 * Read and parse the config file. A MISSING file is not an error — it means
 * "nothing is configured", and every loader has a documented default for that.
 * A file that merely omits a block is indistinguishable from one that doesn't
 * exist, and this makes the two behave the same.
 *
 * It matters because the optional loaders are read from hot, widely-imported
 * modules — `getMaxToolResultChars` from serialize-upstream, `getVisionConfig`
 * from the media path — so a hard throw here turns "no config.toml" into a crash
 * far away from anything the operator would connect to config. config.toml is
 * gitignored, so CI has none: the whole unit suite went red on it once. Without
 * it a config-less deployment also logged an MCP bootstrap failure on every
 * start.
 *
 * Only ENOENT is forgiven. A permissions error, an I/O error, or malformed TOML
 * still throws loudly — those mean a config exists and is broken, which is a real
 * problem an operator needs told about.
 */
export function readConfigToml(path: string): {
	parsed: Record<string, unknown>;
	absolutePath: string;
} {
	const absolutePath = resolve(path);
	let raw: string;
	try {
		raw = readFileSync(absolutePath, 'utf8');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return { parsed: {}, absolutePath };
		}
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

// --- field validators ----------------------------------------------------
// `at` names where the field sits (e.g. `endpoints[2]`), for the message.

/** A string field, non-empty unless `allowEmpty`. */
export function requireString(
	v: unknown,
	field: string,
	at: string,
	opts: { allowEmpty?: boolean } = {},
): string {
	if (opts.allowEmpty) {
		if (typeof v !== 'string') throw new ConfigError(`${at}: '${field}' must be a string`);
		return v;
	}
	if (typeof v !== 'string' || v.length === 0) {
		throw new ConfigError(`${at}: required field '${field}' must be a non-empty string`);
	}
	return v;
}

/** A string field that may be omitted (→ '') but, if present, must be a string. */
export function optionalString(v: unknown, field: string, at: string): string {
	if (v === undefined) return '';
	return requireString(v, field, at, { allowEmpty: true });
}

export function requireBoolean(v: unknown, field: string, at: string): boolean {
	if (typeof v !== 'boolean') {
		throw new ConfigError(`${at}: '${field}' must be a boolean (true or false)`);
	}
	return v;
}

export function requireStringArray(v: unknown, field: string, at: string): string[] {
	if (!Array.isArray(v)) {
		throw new ConfigError(`${at}: '${field}' must be an array of strings`);
	}
	for (let i = 0; i < v.length; i++) {
		if (typeof v[i] !== 'string') {
			throw new ConfigError(`${at}: '${field}[${i}]' must be a string`);
		}
	}
	return v as string[];
}

export function requireNumber(
	v: unknown,
	field: string,
	at: string,
	opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) {
		throw new ConfigError(`${at}: '${field}' must be a number`);
	}
	if (opts.integer && !Number.isInteger(v)) {
		throw new ConfigError(`${at}: '${field}' must be an integer`);
	}
	if (opts.min !== undefined && v < opts.min) {
		throw new ConfigError(`${at}: '${field}' must be >= ${opts.min}`);
	}
	if (opts.max !== undefined && v > opts.max) {
		throw new ConfigError(`${at}: '${field}' must be <= ${opts.max}`);
	}
	return v;
}
