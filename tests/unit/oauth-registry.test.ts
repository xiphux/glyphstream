/**
 * Unit tests for the OAuth provider registry. The registry is the single
 * place that decides which providers exist and which are *available* (flag
 * on AND credentials present). We mock `$lib/server/env` so the enable
 * flags + credential presence can be flipped per test without real env.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
	githubLoginEnabled: true,
	hasGithubCredentials: true,
	googleLoginEnabled: false,
	hasGoogleCredentials: false,
	oidcLoginEnabled: false,
	hasOidcCredentials: false,
	oidcDisplayName: 'SSO',
}));

vi.mock('$lib/server/env', () => ({
	githubLoginEnabled: () => envState.githubLoginEnabled,
	hasGithubCredentials: () => envState.hasGithubCredentials,
	googleLoginEnabled: () => envState.googleLoginEnabled,
	hasGoogleCredentials: () => envState.hasGoogleCredentials,
	oidcLoginEnabled: () => envState.oidcLoginEnabled,
	hasOidcCredentials: () => envState.hasOidcCredentials,
	oidcDisplayName: () => envState.oidcDisplayName,
	// Construction-time getters the provider modules import but never call
	// in these tests (no authorization URL is built here).
	publicBaseUrl: () => 'http://localhost:5173',
	githubClientId: () => 'gh-id',
	githubClientSecret: () => 'gh-sec',
	googleClientId: () => 'g-id',
	googleClientSecret: () => 'g-sec',
	oidcIssuer: () => 'https://issuer.example.com',
	oidcClientId: () => 'o-id',
	oidcClientSecret: () => 'o-sec',
	oidcScopes: () => ['openid', 'profile', 'email'],
}));

import {
	describeProviders,
	getEnabledProvider,
	getProvider,
	isProviderEnabled,
	listEnabledProviders,
} from '$lib/server/auth/oauth/registry';

beforeEach(() => {
	envState.githubLoginEnabled = true;
	envState.hasGithubCredentials = true;
	envState.googleLoginEnabled = false;
	envState.hasGoogleCredentials = false;
	envState.oidcLoginEnabled = false;
	envState.hasOidcCredentials = false;
	envState.oidcDisplayName = 'SSO';
});

describe('registry — lookup', () => {
	it('returns a known provider regardless of enabled state', () => {
		expect(getProvider('github')?.id).toBe('github');
		expect(getProvider('google')?.id).toBe('google');
		expect(getProvider('oidc')?.id).toBe('oidc');
	});

	it('returns null for an unknown provider id', () => {
		expect(getProvider('facebook')).toBeNull();
		expect(getEnabledProvider('facebook')).toBeNull();
		expect(isProviderEnabled('facebook')).toBe(false);
	});
});

describe('registry — enabled gating (flag AND credentials)', () => {
	it('treats github as enabled when flag + credentials are both present', () => {
		expect(isProviderEnabled('github')).toBe(true);
		expect(getEnabledProvider('github')?.id).toBe('github');
	});

	it('treats a flagged-on provider with missing credentials as disabled', () => {
		envState.hasGithubCredentials = false;
		expect(isProviderEnabled('github')).toBe(false);
		expect(getEnabledProvider('github')).toBeNull();
	});

	it('treats a credentialed provider with the flag off as disabled', () => {
		envState.googleLoginEnabled = false;
		envState.hasGoogleCredentials = true;
		expect(isProviderEnabled('google')).toBe(false);
	});

	it('enables google once flag + credentials are both present', () => {
		envState.googleLoginEnabled = true;
		envState.hasGoogleCredentials = true;
		expect(isProviderEnabled('google')).toBe(true);
	});
});

describe('registry — listings', () => {
	it('lists only enabled providers in registration order', () => {
		envState.oidcLoginEnabled = true;
		envState.hasOidcCredentials = true;
		const ids = listEnabledProviders().map((p) => p.id);
		expect(ids).toEqual(['github', 'oidc']); // google still off
	});

	it('describeProviders reports every registered provider with its enabled flag + label', () => {
		envState.oidcDisplayName = 'Company SSO';
		const described = describeProviders();
		expect(described).toEqual([
			{ id: 'github', label: 'GitHub', enabled: true },
			{ id: 'google', label: 'Google', enabled: false },
			{ id: 'oidc', label: 'Company SSO', enabled: false },
		]);
	});
});
