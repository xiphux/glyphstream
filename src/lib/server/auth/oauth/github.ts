/**
 * GitHub OAuth provider. Folds the former `src/lib/server/auth/github.ts`
 * module into the registry shape. GitHub does NOT use PKCE, so
 * `codeVerifier` is always null. Its callback stays at the legacy
 * `/api/auth/github/callback` path so existing operators' registered
 * OAuth-app callback URL keeps working with no reconfiguration.
 */
import { buildAuthorizationURL, exchangeAuthorizationCode, generateState } from './oauth2';
import {
	githubClientId,
	githubClientSecret,
	githubLoginEnabled,
	hasGithubCredentials,
	publicBaseUrl,
} from '../../env';
import type { AuthorizationRequest, OAuthProfile, OAuthProvider } from './types';

export const GITHUB_OAUTH_CALLBACK_PATH = '/api/auth/github/callback';
const GITHUB_AUTHORIZATION_ENDPOINT = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_API = 'https://api.github.com/user';
const GITHUB_USER_EMAILS_API = 'https://api.github.com/user/emails';
const GITHUB_SCOPES = ['read:user', 'user:email'];

function redirectUri(): string {
	return `${publicBaseUrl()}${GITHUB_OAUTH_CALLBACK_PATH}`;
}

async function fetchProfile(code: string): Promise<OAuthProfile> {
	// GitHub reports a failed exchange as `200 {"error": ...}` rather than a
	// 4xx; exchangeAuthorizationCode checks the field on a 200 too, so that
	// still arrives here as an OAuth2RequestError.
	const tokens = await exchangeAuthorizationCode({
		tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
		clientId: githubClientId(),
		clientSecret: githubClientSecret(),
		redirectUri: redirectUri(),
		code,
	});
	const accessToken = tokens.accessToken();

	const userRes = await fetch(GITHUB_USER_API, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'glyphstream',
		},
	});
	if (!userRes.ok) {
		throw new Error(`GitHub /user returned HTTP ${userRes.status}`);
	}
	const user = (await userRes.json()) as {
		id?: unknown;
		login?: unknown;
		name?: unknown;
		email?: unknown;
	};
	if (typeof user.id !== 'number' || typeof user.login !== 'string') {
		throw new Error('GitHub /user response missing required id/login');
	}

	let email: string | null = typeof user.email === 'string' ? user.email : null;
	if (!email) {
		// User has hidden their public email; fetch the verified primary from
		// /user/emails. Best-effort — don't block login if this fails.
		try {
			const emailsRes = await fetch(GITHUB_USER_EMAILS_API, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/vnd.github+json',
					'User-Agent': 'glyphstream',
				},
			});
			if (emailsRes.ok) {
				const list = (await emailsRes.json()) as Array<{
					email: string;
					primary: boolean;
					verified: boolean;
				}>;
				const primary = list.find((e) => e.primary && e.verified);
				if (primary) email = primary.email;
			}
		} catch {
			// swallow — email is non-essential
		}
	}

	return {
		externalId: String(user.id),
		username: user.login,
		name: typeof user.name === 'string' ? user.name : null,
		email,
	};
}

export const githubProvider: OAuthProvider = {
	id: 'github',
	label: () => 'GitHub',
	enabled: () => githubLoginEnabled() && hasGithubCredentials(),
	callbackPath: GITHUB_OAUTH_CALLBACK_PATH,
	createAuthorizationURL(): Promise<AuthorizationRequest> {
		const state = generateState();
		const url = buildAuthorizationURL({
			authorizationEndpoint: GITHUB_AUTHORIZATION_ENDPOINT,
			clientId: githubClientId(),
			redirectUri: redirectUri(),
			state,
			scopes: GITHUB_SCOPES,
		});
		return Promise.resolve({ url, state, codeVerifier: null });
	},
	fetchProfile,
};
