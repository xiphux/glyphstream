// Use SvelteKit's $env/dynamic/private so .env is loaded in dev + values are
// read at runtime in production. drizzle.config.ts and other CLI tooling
// use process.env directly because they run outside SvelteKit's context.

import { env } from '$env/dynamic/private';

function readString(name: string, fallback: string): string {
	return env[name] ?? fallback;
}

function readInt(name: string, fallback: number): number {
	const v = env[name];
	return v ? Number.parseInt(v, 10) : fallback;
}

function requireString(name: string): string {
	const v = env[name];
	if (!v || v.length === 0) {
		throw new Error(`Required environment variable ${name} is not set`);
	}
	return v;
}

// --- storage / config paths ----------------------------------------------

export function dbPath(): string {
	return readString('DB_PATH', './data/glyphstream.db');
}

export function mediaDir(): string {
	return readString('MEDIA_DIR', './data/media');
}

export function mediaGracePeriodDays(): number {
	return readInt('MEDIA_GRACE_PERIOD_DAYS', 7);
}

export function mediaPurgeIntervalSeconds(): number {
	return readInt('MEDIA_PURGE_INTERVAL_SECONDS', 3600);
}

export function configPath(): string {
	return readString('CONFIG_PATH', './config.toml');
}

export function logLevel(): string {
	return readString('LOG_LEVEL', 'info');
}

// --- auth ----------------------------------------------------------------

export function authSecret(): string {
	return requireString('AUTH_SECRET');
}

export function githubClientId(): string {
	return requireString('GITHUB_OAUTH_CLIENT_ID');
}

export function githubClientSecret(): string {
	return requireString('GITHUB_OAUTH_CLIENT_SECRET');
}

export function publicBaseUrl(): string {
	return readString('PUBLIC_BASE_URL', 'http://localhost:5173').replace(/\/+$/, '');
}

export function allowedGithubUserIdsRaw(): string {
	return readString('ALLOWED_GITHUB_USER_IDS', '');
}
