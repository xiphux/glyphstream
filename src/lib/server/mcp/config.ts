import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '$env/dynamic/private';
import { parse as parseToml } from 'smol-toml';
import { configPath } from '../env';

export type McpTransport = 'stdio' | 'http';

const VALID_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http'];

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 900;

/** As declared in config.toml — keys snake_case, before env-var resolution. */
interface RawMcpServer {
	id?: unknown;
	display_name?: unknown;
	transport?: unknown;
	timeout_seconds?: unknown;
	idle_timeout_seconds?: unknown;
	command?: unknown;
	args?: unknown;
	env_from?: unknown;
	url?: unknown;
	api_key_env?: unknown;
}

interface LoadedMcpServerCommon {
	id: string;
	displayName: string;
	/** Per-server connect + per-call timeout in seconds. */
	timeoutSeconds: number;
	/**
	 * For stdio: idle minutes after which the reaper closes the subprocess.
	 * 0 disables reaping. Ignored for http (always 0).
	 */
	idleTimeoutSeconds: number;
}

export interface LoadedStdioMcpServer extends LoadedMcpServerCommon {
	transport: 'stdio';
	command: string;
	args: string[];
	/**
	 * Resolved env vars to pass to the subprocess in addition to the SDK's
	 * default inherited set. Keys are the var name the subprocess sees;
	 * values are resolved from the GlyphStream process's env at load time.
	 */
	env: Record<string, string>;
}

export interface LoadedHttpMcpServer extends LoadedMcpServerCommon {
	transport: 'http';
	url: string;
	apiKey: string | null;
}

export type LoadedMcpServer = LoadedStdioMcpServer | LoadedHttpMcpServer;

export class McpConfigError extends Error {}

function readAndParse(path: string): { parsed: Record<string, unknown>; absolutePath: string } {
	const absolutePath = resolve(path);
	let raw: string;
	try {
		raw = readFileSync(absolutePath, 'utf8');
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new McpConfigError(`Could not read config file at ${absolutePath}: ${cause}`);
	}

	let parsed: unknown;
	try {
		parsed = parseToml(raw);
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new McpConfigError(`Failed to parse TOML at ${absolutePath}: ${cause}`);
	}

	if (typeof parsed !== 'object' || parsed === null) {
		throw new McpConfigError(`Top-level of ${absolutePath} must be a TOML table`);
	}

	return { parsed: parsed as Record<string, unknown>, absolutePath };
}

/** Read + parse + validate the `[[mcp_servers]]` array. Throws on any problem. */
export function loadMcpServers(path = configPath()): LoadedMcpServer[] {
	const { parsed, absolutePath } = readAndParse(path);

	const raw = parsed.mcp_servers;
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		throw new McpConfigError(
			`'mcp_servers' in ${absolutePath} must be an array of [[mcp_servers]] tables`
		);
	}

	const servers: LoadedMcpServer[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const server = validateMcpServer(raw[i] as RawMcpServer, i, absolutePath);
		if (seenIds.has(server.id)) {
			throw new McpConfigError(
				`Duplicate mcp_servers id "${server.id}" in ${absolutePath} — every MCP server must be unique`
			);
		}
		seenIds.add(server.id);
		servers.push(server);
	}
	return servers;
}

function validateMcpServer(raw: RawMcpServer, index: number, path: string): LoadedMcpServer {
	const at = `[[mcp_servers]] #${index} in ${path}`;

	const id = requireString(raw.id, 'id', at);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
		throw new McpConfigError(
			`${at}: id "${id}" must be 1-64 chars, lowercase alphanumeric or dash, starting with alphanumeric`
		);
	}

	const displayName =
		raw.display_name === undefined ? id : requireString(raw.display_name, 'display_name', at);

	const transportStr = requireString(raw.transport, 'transport', at);
	if (!(VALID_TRANSPORTS as readonly string[]).includes(transportStr)) {
		throw new McpConfigError(
			`${at}: transport "${transportStr}" must be one of ${VALID_TRANSPORTS.join(', ')}`
		);
	}
	const transport = transportStr as McpTransport;

	const timeoutSeconds =
		raw.timeout_seconds === undefined
			? DEFAULT_TIMEOUT_SECONDS
			: requireNumber(raw.timeout_seconds, 'timeout_seconds', at, { min: 1 });

	const idleTimeoutSeconds =
		raw.idle_timeout_seconds === undefined
			? DEFAULT_IDLE_TIMEOUT_SECONDS
			: requireNumber(raw.idle_timeout_seconds, 'idle_timeout_seconds', at, { min: 0 });

	const common: LoadedMcpServerCommon = { id, displayName, timeoutSeconds, idleTimeoutSeconds };

	if (transport === 'stdio') {
		const command = requireString(raw.command, 'command', at);
		const args = raw.args === undefined ? [] : requireStringArray(raw.args, 'args', at);
		const envMap = raw.env_from === undefined ? {} : resolveEnvFrom(raw.env_from, at);
		return { ...common, transport: 'stdio', command, args, env: envMap };
	}

	// transport === 'http'
	if (raw.command !== undefined || raw.args !== undefined || raw.env_from !== undefined) {
		throw new McpConfigError(
			`${at}: 'command'/'args'/'env_from' are only valid for transport="stdio"`
		);
	}
	const url = requireString(raw.url, 'url', at);
	if (!/^https?:\/\//.test(url)) {
		throw new McpConfigError(`${at}: url must start with http:// or https://`);
	}

	let apiKey: string | null = null;
	if (raw.api_key_env !== undefined) {
		const envName = requireString(raw.api_key_env, 'api_key_env', at);
		const envValue = env[envName];
		if (!envValue) {
			throw new McpConfigError(
				`${at}: api_key_env="${envName}" but env var ${envName} is unset or empty`
			);
		}
		apiKey = envValue;
	}

	return { ...common, transport: 'http', url, apiKey };
}

function resolveEnvFrom(raw: unknown, at: string): Record<string, string> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new McpConfigError(
			`${at}: 'env_from' must be a table of { SUBPROCESS_VAR = "GLYPHSTREAM_ENV_VAR" } entries`
		);
	}
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const envName = requireString(value, `env_from.${key}`, at);
		const envValue = env[envName];
		if (!envValue) {
			throw new McpConfigError(
				`${at}: env_from.${key}="${envName}" but env var ${envName} is unset or empty`
			);
		}
		result[key] = envValue;
	}
	return result;
}

function requireString(v: unknown, field: string, at: string): string {
	if (typeof v !== 'string' || v.length === 0) {
		throw new McpConfigError(`${at}: required field '${field}' must be a non-empty string`);
	}
	return v;
}

function requireStringArray(v: unknown, field: string, at: string): string[] {
	if (!Array.isArray(v)) {
		throw new McpConfigError(`${at}: '${field}' must be an array of strings`);
	}
	for (let i = 0; i < v.length; i++) {
		if (typeof v[i] !== 'string') {
			throw new McpConfigError(`${at}: '${field}[${i}]' must be a string`);
		}
	}
	return v as string[];
}

function requireNumber(
	v: unknown,
	field: string,
	at: string,
	opts: { min?: number; max?: number } = {}
): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) {
		throw new McpConfigError(`${at}: '${field}' must be a number`);
	}
	if (opts.min !== undefined && v < opts.min) {
		throw new McpConfigError(`${at}: '${field}' must be >= ${opts.min}`);
	}
	if (opts.max !== undefined && v > opts.max) {
		throw new McpConfigError(`${at}: '${field}' must be <= ${opts.max}`);
	}
	return v;
}
