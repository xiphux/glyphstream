// Use SvelteKit's $env/dynamic/private so .env is loaded in dev + values are
// read at runtime in production. drizzle.config.ts and other CLI tooling
// use process.env directly because they run outside SvelteKit's context.
//
// Rule of thumb for any new server module that needs an env var:
//   - Inside SvelteKit (anything under src/) -> import { env } from
//     '$env/dynamic/private'; using process.env will silently miss .env
//     values in pnpm dev because Vite doesn't populate process.env.
//   - In CLI scripts (drizzle.config.ts etc.) -> process.env is fine.

import { env } from '$env/dynamic/private';

function readString(name: string, fallback: string): string {
	return env[name] ?? fallback;
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

// MEDIA_GRACE_PERIOD_DAYS / MEDIA_PURGE_INTERVAL_SECONDS were removed when
// the purger's scope narrowed to abandoned uploads only — see the header
// of src/lib/server/media/purger.ts. Generated media is preserved
// indefinitely now, so the configurability of the sweep timings stopped
// having any meaningful policy decision behind it. The cadence is
// hardcoded in the purger module.

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
	// EXTERNAL_BASE_URL is the URL by which this server is reached from
	// outside (e.g. https://chat.example.com). Used to construct the
	// OAuth callback URL registered with GitHub. Avoid names with the
	// `PUBLIC_` prefix — SvelteKit reserves that for client-exposed env
	// vars and filters them out of `$env/dynamic/private`.
	return readString('EXTERNAL_BASE_URL', 'http://localhost:5173').replace(/\/+$/, '');
}

export function allowedGithubUserIdsRaw(): string {
	return readString('ALLOWED_GITHUB_USER_IDS', '');
}

// --- HTTP transport ------------------------------------------------------

/**
 * On-the-fly compression for dynamic responses (SSR HTML, JSON API).
 * Default off: most deploys put a reverse proxy in front (Caddy / nginx)
 * which compresses dynamic responses there, and leaving this off avoids
 * the round-trip cost of compressing twice.
 *
 * Set COMPRESS_DYNAMIC=1 when the proxy in front *can't* compress —
 * Synology's built-in reverse proxy is the canonical case. See
 * src/lib/server/compression.ts for the skip rules (SSE is always
 * skipped to keep streaming responses unbuffered).
 */
export function compressDynamicResponses(): boolean {
	const v = readString('COMPRESS_DYNAMIC', '').toLowerCase();
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
