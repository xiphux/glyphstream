/**
 * GET /api/auth/github/callback — the SINGLE landing point for every
 * GitHub OAuth round-trip, because GitHub OAuth apps only support one
 * registered callback URL. Three flows fan out from here based on
 * which cookies the matching `start` endpoint stashed:
 *
 *  - Setup flow → `SETUP_GITHUB_CARRY_COOKIE` is set (signed payload
 *    carrying the operator's typed display name + email). We
 *    atomically createInitialUser + addOAuthAccount, then sign in.
 *  - Link-new flow → `LINK_STATE_COOKIE` is set instead of the login
 *    state cookie. The caller already has a session; we
 *    addOAuthAccount onto their existing user and bounce back to
 *    /settings/security.
 *  - Login flow → only `STATE_COOKIE` is set. We look up the existing
 *    binding via findUserByOAuth and create a session.
 *
 * The flow is detected by cookie presence rather than a URL parameter
 * because the path is fixed; the cookies were set under glyphstream's
 * own origin and survive the GitHub round-trip (SameSite=Lax). Each
 * flow uses its own state cookie name so a tab in the middle of one
 * flow can't be hijacked into another.
 */
import { redirect } from '@sveltejs/kit';
import {
	LINK_STATE_COOKIE,
	OAuth2RequestError,
	STATE_COOKIE,
	fetchGithubProfile,
	type GithubUserProfile,
} from '$lib/server/auth/github';
import { SETUP_GITHUB_CARRY_COOKIE } from '$lib/server/auth/setup';
import { verify } from '$lib/server/auth/signed-cookies';
import {
	addOAuthAccount,
	findUserByOAuth,
	touchOAuthAccount,
} from '$lib/server/db/queries/oauth-accounts';
import { bumpUserLastLogin, countUsers, createInitialUser } from '$lib/server/db/queries/users';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

interface SetupCarry {
	displayName: string;
	email: string | null;
}

function loginError(reason: string): never {
	throw redirect(302, `/login?error=${encodeURIComponent(reason)}`);
}

function setupError(reason: string): never {
	throw redirect(302, `/setup?error=${encodeURIComponent(reason)}`);
}

function linkBack(reason: string): never {
	throw redirect(302, `/settings/security?link=${encodeURIComponent(reason)}`);
}

export const GET: RequestHandler = async ({ url, cookies, locals }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');

	// Read every flow-marker cookie up front so we can clear them all,
	// then dispatch on which was set. Each ceremony is single-use.
	const setupCarrySigned = cookies.get(SETUP_GITHUB_CARRY_COOKIE);
	const linkState = cookies.get(LINK_STATE_COOKIE);
	const loginState = cookies.get(STATE_COOKIE);
	cookies.delete(SETUP_GITHUB_CARRY_COOKIE, { path: '/' });
	cookies.delete(LINK_STATE_COOKIE, { path: '/' });
	cookies.delete(STATE_COOKIE, { path: '/' });

	if (setupCarrySigned) {
		await handleSetup({
			cookies,
			code,
			state,
			loginState,
			setupCarrySigned,
		});
		return new Response(); // unreachable — handleSetup always throws redirect
	}

	if (linkState) {
		await handleLink({ cookies, locals, code, state, linkState });
		return new Response(); // unreachable
	}

	await handleLogin({ cookies, code, state, loginState });
	return new Response(); // unreachable
};

async function fetchProfileOr(reason: () => never, code: string): Promise<GithubUserProfile> {
	try {
		return await fetchGithubProfile(code);
	} catch (e) {
		if (e instanceof OAuth2RequestError) reason();
		console.error('[oauth/callback] GitHub profile fetch failed:', e);
		reason();
	}
}

async function handleSetup(args: {
	cookies: import('@sveltejs/kit').Cookies;
	code: string | null;
	state: string | null;
	loginState: string | undefined;
	setupCarrySigned: string;
}): Promise<never> {
	const { cookies, code, state, loginState, setupCarrySigned } = args;

	if (!code || !state || !loginState || state !== loginState) {
		setupError('invalid_oauth_state');
	}
	const carry = verify<SetupCarry>(setupCarrySigned);
	if (!carry) setupError('invalid_oauth_state');

	// Close the parallel-tab race only. The signed carry cookie's
	// existence already proves the start endpoint accepted the
	// SETUP_TOKEN (if any) — re-running the full setupGate here would
	// spuriously fail because GitHub's redirect URI doesn't carry
	// `?token=…`. The carry is HMAC-signed with AUTH_SECRET and TTL'd
	// to 10 min, so it can't be forged or replayed past expiry.
	if (countUsers() > 0) throw redirect(302, '/login');

	const profile = await fetchProfileOr(() => setupError('oauth_exchange_failed'), code);

	const userId = createInitialUser({
		displayName: carry.displayName,
		email: carry.email ?? profile.email,
	});
	addOAuthAccount({
		userId,
		provider: 'github',
		externalId: String(profile.id),
		externalUsername: profile.login,
		externalEmail: profile.email,
	});

	const { token, expiresAt } = createSession(userId);
	setSessionCookie(cookies, token, expiresAt);

	throw redirect(302, '/');
}

async function handleLink(args: {
	cookies: import('@sveltejs/kit').Cookies;
	locals: App.Locals;
	code: string | null;
	state: string | null;
	linkState: string;
}): Promise<never> {
	const { locals, code, state, linkState } = args;

	if (!locals.user) {
		// Session expired mid-flow. Bounce to login; nothing to bind to.
		throw redirect(302, '/login');
	}
	if (!code || !state || state !== linkState) {
		linkBack('invalid_state');
	}

	const profile = await fetchProfileOr(() => linkBack('exchange_failed'), code);

	if (findUserByOAuth('github', String(profile.id))) {
		linkBack('already_linked');
	}

	addOAuthAccount({
		userId: locals.user.id,
		provider: 'github',
		externalId: String(profile.id),
		externalUsername: profile.login,
		externalEmail: profile.email,
	});

	linkBack('success');
}

async function handleLogin(args: {
	cookies: import('@sveltejs/kit').Cookies;
	code: string | null;
	state: string | null;
	loginState: string | undefined;
}): Promise<never> {
	const { cookies, code, state, loginState } = args;

	if (!code || !state || !loginState || state !== loginState) {
		loginError('invalid_oauth_state');
	}

	const profile = await fetchProfileOr(() => loginError('oauth_exchange_failed'), code);
	const externalId = String(profile.id);
	const binding = findUserByOAuth('github', externalId);

	if (!binding) {
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

	touchOAuthAccount('github', externalId, {
		externalUsername: profile.login,
		externalEmail: profile.email,
	});
	bumpUserLastLogin(binding.userId);

	const { token, expiresAt } = createSession(binding.userId);
	setSessionCookie(cookies, token, expiresAt);

	throw redirect(302, '/');
}
