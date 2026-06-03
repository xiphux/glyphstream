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

function readBool(name: string, fallback: boolean): boolean {
	const raw = env[name];
	if (raw === undefined || raw === '') return fallback;
	const v = raw.toLowerCase();
	if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
	if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
	return fallback;
}

/**
 * Whether the GitHub OAuth button is shown on /login. Default on. OAuth
 * is pure authentication against an existing `oauth_accounts` binding;
 * an unbound external_id is refused with `provider_not_bound`. So
 * disabling this on a passkey-only operator simply hides a button that
 * wouldn't work for them anyway.
 */
export function githubLoginEnabled(): boolean {
	return readBool('GITHUB_LOGIN_ENABLED', true);
}

/**
 * Whether the passkey login button is shown on /login and the
 * register/verify endpoints accept requests. Default on — operators that
 * don't want passkeys can flip this off explicitly. Disabling does NOT
 * delete existing rows; the settings page still lets the user prune them.
 */
export function passkeyLoginEnabled(): boolean {
	return readBool('PASSKEY_LOGIN_ENABLED', true);
}

/**
 * Refuse to start if no login method is enabled. Called from
 * hooks.server.ts at module load so a misconfig becomes a crash instead
 * of a dead instance. Also surfaces an early warning when passkeys are
 * on without a properly-set EXTERNAL_BASE_URL in production, since the
 * RP ID is derived from it and changing it later invalidates every
 * registered credential.
 */
export function validateAuthMethodsEnabled(): void {
	const github = githubLoginEnabled();
	const passkey = passkeyLoginEnabled();
	if (!github && !passkey) {
		throw new Error(
			'No login methods enabled. Set GITHUB_LOGIN_ENABLED=1 or PASSKEY_LOGIN_ENABLED=1.',
		);
	}
	if (
		passkey &&
		process.env.NODE_ENV === 'production' &&
		publicBaseUrl() === 'http://localhost:5173'
	) {
		throw new Error(
			'PASSKEY_LOGIN_ENABLED=1 in production requires EXTERNAL_BASE_URL to be set to this server’s public origin. The WebAuthn RP ID is derived from it; the dev fallback would lock every passkey to localhost.',
		);
	}
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
