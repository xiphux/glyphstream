/**
 * Boot-gate tests for validateAuthMethodsEnabled(). The gate must mirror
 * what the auth pages actually render — a provider counts only when its
 * flag is on AND its credentials are configured — so a deployment can never
 * boot to a login page with zero actionable controls (e.g. GitHub flagged
 * on by default but no credentials + passkeys off).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAuthMethodsEnabled } from '#lib/server/env.js';

// Every variable the gate reads starts UNSET, whatever the machine running the
// suite has in its environment — "nothing set" is the baseline each case below
// is written against, and a developer's shell exporting GITHUB_OAUTH_CLIENT_ID
// would otherwise quietly change what these assert.
const AUTH_VARS = [
	'GITHUB_LOGIN_ENABLED',
	'GITHUB_OAUTH_CLIENT_ID',
	'GITHUB_OAUTH_CLIENT_SECRET',
	'GOOGLE_LOGIN_ENABLED',
	'GOOGLE_OAUTH_CLIENT_ID',
	'GOOGLE_OAUTH_CLIENT_SECRET',
	'OIDC_LOGIN_ENABLED',
	'OIDC_ISSUER',
	'OIDC_CLIENT_ID',
	'OIDC_CLIENT_SECRET',
	'OIDC_DISPLAY_NAME',
	'OIDC_SCOPES',
	'PASSKEY_LOGIN_ENABLED',
];

beforeEach(() => {
	for (const k of AUTH_VARS) vi.stubEnv(k, undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('validateAuthMethodsEnabled — availability gate', () => {
	it('throws when GitHub is flagged on (default) but has no credentials and passkeys are off', () => {
		// Nothing set → GitHub flag defaults on, but no credentials present.
		vi.stubEnv('PASSKEY_LOGIN_ENABLED', '0');
		expect(() => validateAuthMethodsEnabled()).toThrow(/no usable login methods/i);
	});

	it('boots when GitHub has credentials, even with passkeys off', () => {
		vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', 'id');
		vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', 'sec');
		vi.stubEnv('PASSKEY_LOGIN_ENABLED', '0');
		expect(() => validateAuthMethodsEnabled()).not.toThrow();
	});

	it('boots on passkeys alone when no provider is usable', () => {
		vi.stubEnv('GITHUB_LOGIN_ENABLED', '0');
		// PASSKEY defaults on.
		expect(() => validateAuthMethodsEnabled()).not.toThrow();
	});

	it('boots when only Google is configured (flag + credentials)', () => {
		vi.stubEnv('GITHUB_LOGIN_ENABLED', '0');
		vi.stubEnv('PASSKEY_LOGIN_ENABLED', '0');
		vi.stubEnv('GOOGLE_LOGIN_ENABLED', '1');
		vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'id');
		vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'sec');
		expect(() => validateAuthMethodsEnabled()).not.toThrow();
	});

	it('throws when a provider is flagged on but its credentials are missing', () => {
		vi.stubEnv('GITHUB_LOGIN_ENABLED', '0');
		vi.stubEnv('PASSKEY_LOGIN_ENABLED', '0');
		vi.stubEnv('OIDC_LOGIN_ENABLED', '1'); // no OIDC_ISSUER / client creds
		expect(() => validateAuthMethodsEnabled()).toThrow(/no usable login methods/i);
	});
});
