/**
 * Boot-gate tests for validateAuthMethodsEnabled(). The gate must mirror
 * what the auth pages actually render — a provider counts only when its
 * flag is on AND its credentials are configured — so a deployment can never
 * boot to a login page with zero actionable controls (e.g. GitHub flagged
 * on by default but no credentials + passkeys off).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envStore = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env: envStore }));

import { validateAuthMethodsEnabled } from '$lib/server/env';

beforeEach(() => {
	for (const k of Object.keys(envStore)) delete envStore[k];
});

afterEach(() => {
	for (const k of Object.keys(envStore)) delete envStore[k];
});

describe('validateAuthMethodsEnabled — availability gate', () => {
	it('throws when GitHub is flagged on (default) but has no credentials and passkeys are off', () => {
		// Nothing set → GitHub flag defaults on, but no credentials present.
		envStore.PASSKEY_LOGIN_ENABLED = '0';
		expect(() => validateAuthMethodsEnabled()).toThrow(/no usable login methods/i);
	});

	it('boots when GitHub has credentials, even with passkeys off', () => {
		envStore.GITHUB_OAUTH_CLIENT_ID = 'id';
		envStore.GITHUB_OAUTH_CLIENT_SECRET = 'sec';
		envStore.PASSKEY_LOGIN_ENABLED = '0';
		expect(() => validateAuthMethodsEnabled()).not.toThrow();
	});

	it('boots on passkeys alone when no provider is usable', () => {
		envStore.GITHUB_LOGIN_ENABLED = '0';
		// PASSKEY defaults on.
		expect(() => validateAuthMethodsEnabled()).not.toThrow();
	});

	it('boots when only Google is configured (flag + credentials)', () => {
		envStore.GITHUB_LOGIN_ENABLED = '0';
		envStore.PASSKEY_LOGIN_ENABLED = '0';
		envStore.GOOGLE_LOGIN_ENABLED = '1';
		envStore.GOOGLE_OAUTH_CLIENT_ID = 'id';
		envStore.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
		expect(() => validateAuthMethodsEnabled()).not.toThrow();
	});

	it('throws when a provider is flagged on but its credentials are missing', () => {
		envStore.GITHUB_LOGIN_ENABLED = '0';
		envStore.PASSKEY_LOGIN_ENABLED = '0';
		envStore.OIDC_LOGIN_ENABLED = '1'; // no OIDC_ISSUER / client creds
		expect(() => validateAuthMethodsEnabled()).toThrow(/no usable login methods/i);
	});
});
