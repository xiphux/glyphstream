/**
 * Reading `config.toml`: the file itself, the warning for keys no loader reads,
 * and the field validators every block's loader shares (endpoints, MCP servers,
 * the code interpreter).
 *
 * One `ConfigError` for all of them, so a caller that degrades on a broken
 * config (the model list, the endpoint status page) catches every block's
 * failure, not just the endpoints'.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { createLogger } from '../log';
import { memoizeConfig } from '../util/config-cache';

const log = createLogger('config');

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
 * gitignored, so CI has none, and a throw turns the whole unit suite red. A
 * config-less deployment would also log an MCP bootstrap failure on every
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

	warnUnknownConfigKeys(parsed as Record<string, unknown>, absolutePath);
	return { parsed: parsed as Record<string, unknown>, absolutePath };
}

/**
 * Every section of config.toml and the keys its loader reads. Anything not
 * listed is warned about at load: no loader reads it, so a typo'd setting would
 * otherwise run on its default with nothing at boot to say so. Adding a key to a
 * loader means adding it here,
 * or every config that sets it logs a false warning (`config-unknown-keys.test.ts`
 * checks config.toml.example against this).
 *
 * Tables nested under a key (`model_context_windows`, `style_instructions`,
 * `env_from`) are maps of operator-chosen names, so only the section's own keys
 * are checked.
 */
export const CONFIG_SECTIONS: Readonly<Record<string, { array?: true; keys: readonly string[] }>> =
	{
		endpoints: {
			array: true,
			keys: [
				'id',
				'display_name',
				'base_url',
				'api_key_env',
				'request_timeout_seconds',
				'provider_quirk',
				'group_by',
				'supports_tools',
				'local',
				'max_concurrent',
				'resource_group',
				'release',
				'context_window',
				'model_context_windows',
				'model_prompt_styles',
				'model_prompt_hints',
			],
		},
		mcp_servers: {
			array: true,
			keys: [
				'id',
				'display_name',
				'transport',
				'auth',
				'timeout_seconds',
				'idle_timeout_seconds',
				'command',
				'args',
				'env_from',
				'url',
				'api_key_env',
				'defer_tools',
				'post_only',
			],
		},
		// Also accepted as the legacy bare root scalar `task_model = "…"`.
		task_model: { keys: ['model', 'private'] },
		notifications: { keys: ['vapid_public', 'vapid_private_env', 'vapid_subject'] },
		image_enhancement: { keys: ['model', 'max_tokens', 'temperature', 'style_instructions'] },
		memory_model: {
			keys: [
				'model',
				'max_tokens',
				'temperature',
				'active_hours',
				'timezone',
				'overview_max_chars',
			],
		},
		tools: { keys: ['max_tool_loop_iterations', 'max_tool_result_chars'] },
		limits: { keys: ['max_queued_generations_per_user'] },
		vision: { keys: ['max_image_dim', 'image_quality'] },
		search: { keys: ['url', 'api_key_env', 'timeout_seconds'] },
		embeddings: {
			keys: [
				'endpoint_id',
				'model_id',
				'timeout_seconds',
				'query_prefix',
				'document_prefix',
				'max_input_tokens',
				'gallery_search_min_similarity',
			],
		},
		rerank: { keys: ['endpoint_id', 'model_id', 'timeout_seconds', 'top_n', 'quirk'] },
		scheduled_tasks: {
			keys: [
				'enabled',
				'max_per_user',
				'min_interval_hours',
				'default_deadline_minutes',
				'keep_runs',
				'disable_after_failures',
			],
		},
		check_ins: { keys: ['enabled'] },
		code_interpreter: {
			keys: [
				'enabled',
				'pool_max',
				'idle_timeout_seconds',
				'call_timeout_seconds',
				'worker_memory_mb',
				'python_memory_mb',
				'pyodide_index_url',
			],
		},
	};

/**
 * Warnings already logged. Every loader re-reads the file, so without this one
 * typo would be reported once per section loaded. Held as config so a test's
 * `resetConfigCachesForTests()` clears it with the rest.
 */
const warned = memoizeConfig(() => new Set<string>());

function isTable(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Log, once per process, every section and key in `parsed` that no loader
 * reads. Warns rather than refuses: a stray key is not worth a server that
 * won't start. Values of the wrong shape are left to the section's loader,
 * which throws on them.
 */
export function warnUnknownConfigKeys(parsed: Record<string, unknown>, absolutePath: string): void {
	const sectionNames = Object.keys(CONFIG_SECTIONS);
	for (const [name, value] of Object.entries(parsed)) {
		const section = CONFIG_SECTIONS[name];
		if (section === undefined) {
			const what = isTable(value) ? `section [${name}]` : `top-level key '${name}'`;
			warnOnce(`${absolutePath}: unknown ${what} is ignored${didYouMean(name, sectionNames)}`);
			continue;
		}
		if (section.array) {
			if (!Array.isArray(value)) continue;
			value.forEach((entry, i) => {
				if (isTable(entry)) {
					warnUnknownKeys(entry, `[[${name}]] #${i} in ${absolutePath}`, section.keys);
				}
			});
		} else if (isTable(value)) {
			warnUnknownKeys(value, `[${name}] in ${absolutePath}`, section.keys);
		}
	}
}

/** Warn about each key of `table` not in `allowed`; `at` names the table. */
export function warnUnknownKeys(
	table: Record<string, unknown>,
	at: string,
	allowed: readonly string[],
): void {
	for (const key of Object.keys(table)) {
		if (!allowed.includes(key)) {
			warnOnce(`${at}: unknown key '${key}' is ignored${didYouMean(key, allowed)}`);
		}
	}
}

function warnOnce(message: string): void {
	const seen = warned();
	if (seen.has(message)) return;
	seen.add(message);
	log.warn(message);
}

/** ` (did you mean 'x'?)` for the closest candidate within a typo's reach, else ''. */
function didYouMean(name: string, candidates: readonly string[]): string {
	const reach = Math.max(2, Math.floor(name.length / 3));
	let best: string | null = null;
	let bestDistance = reach + 1;
	for (const c of candidates) {
		const d = editDistance(name, c);
		if (d < bestDistance) {
			best = c;
			bestDistance = d;
		}
	}
	return best === null ? '' : ` (did you mean '${best}'?)`;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = row;
	}
	return prev[b.length];
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
