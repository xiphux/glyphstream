import { redirect } from '@sveltejs/kit';
import { OAuth2RequestError, fetchGithubProfile } from '$lib/server/auth/github';
import { isAllowed } from '$lib/server/auth/allowlist';
import { upsertUserByGithub } from '$lib/server/db/queries/users';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

const STATE_COOKIE = 'glyphstream_oauth_state';

function loginError(reason: string): never {
	throw redirect(302, `/login?error=${encodeURIComponent(reason)}`);
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get(STATE_COOKIE);
	cookies.delete(STATE_COOKIE, { path: '/' });

	if (!code || !state || !storedState || state !== storedState) {
		loginError('invalid_oauth_state');
	}

	let profile;
	try {
		profile = await fetchGithubProfile(code);
	} catch (e) {
		if (e instanceof OAuth2RequestError) {
			loginError('oauth_exchange_failed');
		}
		console.error('[oauth/callback] GitHub profile fetch failed:', e);
		loginError('upstream_failure');
	}

	if (!isAllowed(profile.id)) {
		console.warn(
			`[oauth/callback] Rejecting GitHub user "${profile.login}" (id=${profile.id}) — not in allowlist`
		);
		loginError('not_authorized');
	}

	const userId = upsertUserByGithub({
		githubUserId: profile.id,
		githubUsername: profile.login,
		email: profile.email,
		displayName: profile.name
	});

	const { token, expiresAt } = createSession(userId);
	setSessionCookie(cookies, token, expiresAt);

	throw redirect(302, '/');
};
