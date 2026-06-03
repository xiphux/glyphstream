import { GitHub, OAuth2RequestError } from 'arctic';
import { githubClientId, githubClientSecret, publicBaseUrl } from '../env';

export const GITHUB_OAUTH_CALLBACK_PATH = '/api/auth/github/callback';
const GITHUB_USER_API = 'https://api.github.com/user';
const GITHUB_USER_EMAILS_API = 'https://api.github.com/user/emails';

/**
 * Name of the cookie carrying the OAuth `state` value between the login
 * redirect and the callback. The login route writes it; the callback
 * reads it back to defend against CSRF — the two MUST agree, so the name
 * lives here and is imported by both rather than being two string
 * literals that a typo could silently desync.
 */
export const STATE_COOKIE = 'glyphstream_oauth_state';

/**
 * Distinct state cookie for the *link* flow (Settings → Security →
 * "Link GitHub"). Separating it from the login STATE_COOKIE means a
 * tab in the middle of a login flow can't be confused for a link
 * flow if the callback URLs are ever crossed.
 */
export const LINK_STATE_COOKIE = 'glyphstream_oauth_link_state';

/** How long the user has to complete the GitHub round-trip before the
 *  OAuth state cookie expires. */
export const STATE_TTL_SECONDS = 600;

let cached: GitHub | null = null;

export function getGithubClient(): GitHub {
	if (!cached) {
		const callbackUrl = `${publicBaseUrl()}${GITHUB_OAUTH_CALLBACK_PATH}`;
		cached = new GitHub(githubClientId(), githubClientSecret(), callbackUrl);
	}
	return cached;
}

export interface GithubUserProfile {
	id: number;
	login: string;
	name: string | null;
	email: string | null;
}

/**
 * Exchange an authorization code for the GitHub user's profile. Throws on
 * any upstream failure (invalid code, network error, malformed user payload).
 */
export async function fetchGithubProfile(code: string): Promise<GithubUserProfile> {
	const client = getGithubClient();
	const tokens = await client.validateAuthorizationCode(code);
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
		id: user.id,
		login: user.login,
		name: typeof user.name === 'string' ? user.name : null,
		email,
	};
}

export { OAuth2RequestError };
