/**
 * GET /api/auth/github/callback — finish a GitHub OAuth ceremony.
 *
 * OAuth here is pure authentication against an existing
 * `oauth_accounts` binding — it never creates a user on the fly. The
 * binding is established deliberately:
 *  - by PR 2's `/setup` wizard (creates the first user + first binding
 *    atomically), or
 *  - by PR 2's Settings → Security "Link GitHub" flow (an already-
 *    signed-in operator linking a provider to their existing account).
 *
 * A callback whose GitHub profile id isn't already in `oauth_accounts`
 * is refused — there is no allowlist and no auto-create path. This
 * makes the single-user-cap structural rather than list-maintained.
 */
import { redirect } from '@sveltejs/kit';
import { OAuth2RequestError, STATE_COOKIE, fetchGithubProfile } from '$lib/server/auth/github';
import { findUserByOAuth, touchOAuthAccount } from '$lib/server/db/queries/oauth-accounts';
import { bumpUserLastLogin, countUsers } from '$lib/server/db/queries/users';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

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

	const externalId = String(profile.id);
	const binding = findUserByOAuth('github', externalId);

	if (!binding) {
		// No matching oauth_accounts row. The two refusal paths give the
		// operator a distinct hint at /login:
		//  - count === 0 → "no user exists; complete /setup first"
		//  - count > 0  → "this GitHub account isn't linked to the operator"
		if (countUsers() === 0) {
			console.warn(
				`[oauth/callback] Rejecting GitHub user "${profile.login}" (id=${profile.id}) — no operator account exists yet`,
			);
			loginError('setup_required');
		}
		console.warn(
			`[oauth/callback] Rejecting GitHub user "${profile.login}" (id=${profile.id}) — not bound to any account`,
		);
		loginError('provider_not_bound');
	}

	if (binding.disabledAt !== null) {
		console.warn(
			`[oauth/callback] Rejecting GitHub user "${profile.login}" (id=${profile.id}) — bound user is disabled`,
		);
		loginError('not_authorized');
	}

	// Refresh the provider's view of the operator's identity (their
	// GitHub username can change between logins; the bound row should
	// reflect what GitHub says now).
	touchOAuthAccount('github', externalId, {
		externalUsername: profile.login,
		externalEmail: profile.email,
	});
	bumpUserLastLogin(binding.userId);

	const { token, expiresAt } = createSession(binding.userId);
	setSessionCookie(cookies, token, expiresAt);

	throw redirect(302, '/');
};
