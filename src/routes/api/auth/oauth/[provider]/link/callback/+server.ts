/**
 * GET /api/auth/oauth/:provider/link/callback — finish a link round-
 * trip. Validates state + session, fetches the GitHub profile, refuses
 * if the resulting (provider, external_id) is already in
 * `oauth_accounts` (defensively — single-user-cap means it shouldn't
 * be possible unless the user already linked this account), otherwise
 * binds the row to the current session's user.
 *
 * On success / failure, redirects back to /settings/security with a
 * `?link=…` query param that the page surfaces via toast.
 */
import { redirect } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { OAuth2RequestError, fetchGithubProfile } from '$lib/server/auth/github';
import { addOAuthAccount, findUserByOAuth } from '$lib/server/db/queries/oauth-accounts';
import { LINK_STATE_COOKIE } from '../start/+server';
import type { RequestHandler } from './$types';

function back(reason: string): never {
	throw redirect(302, `/settings/security?link=${encodeURIComponent(reason)}`);
}

export const GET: RequestHandler = async ({ locals, url, cookies, params }) => {
	requireUser(locals);
	if (params.provider !== 'github') back('unknown_provider');

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get(LINK_STATE_COOKIE);
	cookies.delete(LINK_STATE_COOKIE, { path: '/' });
	if (!code || !state || !storedState || state !== storedState) {
		back('invalid_state');
	}

	let profile;
	try {
		profile = await fetchGithubProfile(code);
	} catch (e) {
		if (e instanceof OAuth2RequestError) back('exchange_failed');
		console.error('[oauth/link/callback] profile fetch failed:', e);
		back('upstream_failure');
	}

	// Refuse if the binding already exists. Two cases collapse into one
	// 409-style refusal:
	//   - Same user already has this GitHub account linked.
	//   - Different external_id already on file (shouldn't happen under
	//     single-user-cap but defends against it).
	if (findUserByOAuth('github', String(profile.id))) {
		back('already_linked');
	}

	addOAuthAccount({
		userId: locals.user.id,
		provider: 'github',
		externalId: String(profile.id),
		externalUsername: profile.login,
		externalEmail: profile.email,
	});

	back('success');
};
