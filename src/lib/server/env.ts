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

/** True when an env var is set to a non-empty value. Used by the OAuth
 *  registry to decide whether a provider is *configured* (vs. merely
 *  flagged on) — a provider only surfaces a button when both its
 *  `*_LOGIN_ENABLED` flag is on AND its credentials are present, so a
 *  half-configured provider never shows a button that would 500 on click. */
function hasString(name: string): boolean {
	const v = env[name];
	return !!v && v.length > 0;
}

// --- storage / config paths ----------------------------------------------

export function dbPath(): string {
	return readString('DB_PATH', './data/glyphstream.db');
}

export function mediaDir(): string {
	return readString('MEDIA_DIR', './data/media');
}

export function skillsDir(): string {
	return readString('SKILLS_DIR', './data/skills');
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

export function hasGithubCredentials(): boolean {
	return hasString('GITHUB_OAUTH_CLIENT_ID') && hasString('GITHUB_OAUTH_CLIENT_SECRET');
}

export function googleClientId(): string {
	return requireString('GOOGLE_OAUTH_CLIENT_ID');
}

export function googleClientSecret(): string {
	return requireString('GOOGLE_OAUTH_CLIENT_SECRET');
}

export function hasGoogleCredentials(): boolean {
	return hasString('GOOGLE_OAUTH_CLIENT_ID') && hasString('GOOGLE_OAUTH_CLIENT_SECRET');
}

/** Issuer base URL for the generic OIDC provider, e.g.
 *  https://auth.example.com — discovery happens at
 *  `<issuer>/.well-known/openid-configuration`. Trailing slash trimmed so
 *  the well-known path is appended cleanly. */
export function oidcIssuer(): string {
	return requireString('OIDC_ISSUER').replace(/\/+$/, '');
}

export function oidcClientId(): string {
	return requireString('OIDC_CLIENT_ID');
}

export function oidcClientSecret(): string {
	return requireString('OIDC_CLIENT_SECRET');
}

export function hasOidcCredentials(): boolean {
	return hasString('OIDC_ISSUER') && hasString('OIDC_CLIENT_ID') && hasString('OIDC_CLIENT_SECRET');
}

/** Button label for the generic OIDC provider. Defaults to "SSO" since the
 *  issuer's brand name isn't discoverable. Operators set OIDC_DISPLAY_NAME
 *  to match their IdP ("Authentik", "Keycloak", "Company SSO"). */
export function oidcDisplayName(): string {
	return readString('OIDC_DISPLAY_NAME', 'SSO').trim() || 'SSO';
}

/** Scopes requested from the OIDC issuer. `openid` is mandatory for an ID
 *  token; `profile`+`email` populate the display name / email snapshot.
 *  Space-separated, overridable for issuers with non-standard scope names. */
export function oidcScopes(): string[] {
	return readString('OIDC_SCOPES', 'openid profile email')
		.split(/\s+/)
		.filter((s) => s.length > 0);
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
 * Whether the Google OAuth button is shown on the auth pages. Default
 * off — unlike GitHub (on by default for continuity), a fresh install
 * shouldn't surface a Google button until the operator opts in. The
 * registry additionally requires credentials to be present before the
 * button renders (see `hasGoogleCredentials`).
 */
export function googleLoginEnabled(): boolean {
	return readBool('GOOGLE_LOGIN_ENABLED', false);
}

/**
 * Whether the generic OIDC button is shown. Default off; requires
 * OIDC_ISSUER + client credentials to actually surface (see
 * `hasOidcCredentials`).
 */
export function oidcLoginEnabled(): boolean {
	return readBool('OIDC_LOGIN_ENABLED', false);
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
 * Optional bootstrap token gating the /setup wizard. When set, /setup
 * requires `?token=<value>` (constant-time compared) before any of its
 * flows are reachable; when unset, /setup is openly accessible while
 * the user count is zero. The token has no effect after the first user
 * is created — /setup is closed structurally at that point.
 *
 * Empty string means "no token required" (the default). Operators on a
 * known-indexed subdomain who want defense-in-depth set this to a
 * random value.
 */
export function setupToken(): string {
	return readString('SETUP_TOKEN', '').trim();
}

/**
 * Master key for encrypting per-user MCP credentials at rest (AES-256-GCM,
 * HKDF-derived — see src/lib/server/crypto/secret-box.ts).
 *
 * Optional: defaults to AUTH_SECRET (which is always set), so per-user MCP
 * needs no extra setup. That's safe because the crypto layer HKDF-derives with
 * a distinct `info` label — the derived key is independent of AUTH_SECRET's
 * other use (signed cookies), even when it's the same input.
 *
 * Set MCP_SECRET_KEY explicitly only to rotate MCP-credential encryption
 * independently of session secrets: with it set, rotating AUTH_SECRET (e.g.
 * after a cookie leak) leaves stored MCP tokens intact. Rotating whichever key
 * is in effect invalidates every stored MCP credential — treat it as durable.
 */
export function mcpSecretKey(): string {
	return readString('MCP_SECRET_KEY', '').trim() || authSecret();
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
	// Flag-based gate: any enabled OAuth provider OR passkeys satisfies it.
	// (The per-provider credentials check lives in the registry's
	// `enabled()` — this boot gate only guards the "nothing turned on at
	// all" misconfig, so an OIDC-only or Google-only deploy boots fine.)
	const anyOAuth = githubLoginEnabled() || googleLoginEnabled() || oidcLoginEnabled();
	const passkey = passkeyLoginEnabled();
	if (!anyOAuth && !passkey) {
		throw new Error(
			'No login methods enabled. Enable at least one: GITHUB_LOGIN_ENABLED, ' +
				'GOOGLE_LOGIN_ENABLED, OIDC_LOGIN_ENABLED, or PASSKEY_LOGIN_ENABLED.',
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
