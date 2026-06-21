/**
 * The SINGLE OAuth callback dispatcher, shared by every provider. Two thin
 * route files feed it: the legacy `/api/auth/github/callback` (back-compat)
 * and the generic `/api/auth/oauth/[provider]/callback`. Both pass the
 * resolved provider — so the PROVIDER IS DETERMINED BY THE ROUTE, never by
 * a cookie. The carry cookies are provider-neutral; they only distinguish
 * which *flow* (setup / join / link / login) is in progress:
 *
 *  - Setup flow → `SETUP_OAUTH_CARRY_COOKIE` set (signed display name +
 *    email). createInitialUser + addOAuthAccount, then sign in.
 *  - Join flow → `JOIN_OAUTH_CARRY_COOKIE` set (signed name + email +
 *    inviteToken). finalizeOAuthJoin in one transaction.
 *  - Link flow → `LINK_STATE_COOKIE` set; caller already has a session.
 *    addOAuthAccount onto their user, bounce to /settings/security.
 *  - Login flow → only `STATE_COOKIE` set. findUserByOAuth + create session.
 *
 * Flow is detected by cookie presence; the cookies were set under
 * glyphstream's own origin and survive the provider round-trip
 * (SameSite=Lax). Each flow uses its own state cookie name so a tab mid-
 * one-flow can't be hijacked into another. PKCE providers additionally
 * carry a code verifier (CODE_VERIFIER_COOKIE).
 */
import { redirect } from '@sveltejs/kit';
import type { Cookies } from '@sveltejs/kit';
import { OAuth2RequestError } from 'arctic';
import { SETUP_OAUTH_CARRY_COOKIE } from '../setup';
import { JOIN_OAUTH_CARRY_COOKIE, InviteConsumedError, finalizeOAuthJoin } from '../join';
import { verify } from '../signed-cookies';
import { createSession, setSessionCookie } from '../session';
import {
	addOAuthAccount,
	findUserByOAuth,
	touchOAuthAccount,
} from '../../db/queries/oauth-accounts';
import { findValidInvite } from '../../db/queries/invites';
import { bumpUserLastLogin, countUsers, createInitialUser } from '../../db/queries/users';
import { CODE_VERIFIER_COOKIE, LINK_STATE_COOKIE, STATE_COOKIE } from './cookies';
import type { OAuthProfile, OAuthProvider } from './types';

interface SetupCarry {
	displayName: string;
	email: string | null;
}

interface JoinCarry {
	displayName: string;
	email: string | null;
	inviteToken: string;
}

interface CallbackContext {
	url: URL;
	cookies: Cookies;
	locals: App.Locals;
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

/**
 * Entry point. Reads every flow-marker cookie up front, clears them all
 * (each ceremony is single-use), then dispatches on which was set. Always
 * throws a redirect — the route wrapper's trailing `return` is unreachable.
 */
export async function handleOAuthCallback(
	provider: OAuthProvider,
	ctx: CallbackContext,
): Promise<never> {
	const { url, cookies, locals } = ctx;
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');

	const setupCarrySigned = cookies.get(SETUP_OAUTH_CARRY_COOKIE);
	const joinCarrySigned = cookies.get(JOIN_OAUTH_CARRY_COOKIE);
	const linkState = cookies.get(LINK_STATE_COOKIE);
	const loginState = cookies.get(STATE_COOKIE);
	const codeVerifier = cookies.get(CODE_VERIFIER_COOKIE) ?? null;
	cookies.delete(SETUP_OAUTH_CARRY_COOKIE, { path: '/' });
	cookies.delete(JOIN_OAUTH_CARRY_COOKIE, { path: '/' });
	cookies.delete(LINK_STATE_COOKIE, { path: '/' });
	cookies.delete(STATE_COOKIE, { path: '/' });
	cookies.delete(CODE_VERIFIER_COOKIE, { path: '/' });

	if (setupCarrySigned) {
		return handleSetup({
			provider,
			cookies,
			code,
			state,
			loginState,
			codeVerifier,
			setupCarrySigned,
		});
	}
	if (joinCarrySigned) {
		return handleJoin({
			provider,
			cookies,
			code,
			state,
			loginState,
			codeVerifier,
			joinCarrySigned,
		});
	}
	if (linkState) {
		return handleLink({ provider, locals, code, state, linkState, codeVerifier });
	}
	return handleLogin({ provider, cookies, code, state, loginState, codeVerifier });
}

/**
 * Run the profile fetch and translate failures into the caller's two error
 * codes. OAuth-protocol failures (bad code, invalid client) → `oauthError`;
 * everything else (network down, malformed JSON, 5xx, OIDC discovery
 * failure) → `upstreamError`. Keeping them distinct lets the message
 * distinguish "your sign-in failed" from "the provider is having a bad day."
 */
async function fetchProfileOr(
	provider: OAuthProvider,
	reasons: { oauthError: () => never; upstreamError: () => never },
	code: string,
	codeVerifier: string | null,
): Promise<OAuthProfile> {
	try {
		return await provider.fetchProfile(code, codeVerifier);
	} catch (e) {
		if (e instanceof OAuth2RequestError) reasons.oauthError();
		console.error(`[oauth/callback] ${provider.id} profile fetch failed:`, e);
		reasons.upstreamError();
	}
}

async function handleSetup(args: {
	provider: OAuthProvider;
	cookies: Cookies;
	code: string | null;
	state: string | null;
	loginState: string | undefined;
	codeVerifier: string | null;
	setupCarrySigned: string;
}): Promise<never> {
	const { provider, cookies, code, state, loginState, codeVerifier, setupCarrySigned } = args;

	if (!code || !state || !loginState || state !== loginState) {
		setupError('invalid_oauth_state');
	}
	const carry = verify<SetupCarry>(setupCarrySigned);
	if (!carry) setupError('invalid_oauth_state');

	// Close the parallel-tab race only. The signed carry cookie's existence
	// already proves the start endpoint accepted the SETUP_TOKEN (if any) —
	// re-running the full setupGate here would spuriously fail because the
	// provider's redirect URI doesn't carry `?token=…`. The carry is
	// HMAC-signed with AUTH_SECRET and TTL'd to 10 min, so it can't be
	// forged or replayed past expiry.
	if (countUsers() > 0) throw redirect(302, '/login');

	const profile = await fetchProfileOr(
		provider,
		{
			oauthError: () => setupError('oauth_exchange_failed'),
			upstreamError: () => setupError('upstream_failure'),
		},
		code,
		codeVerifier,
	);

	const userId = createInitialUser({
		displayName: carry.displayName,
		email: carry.email ?? profile.email,
	});
	addOAuthAccount({
		userId,
		provider: provider.id,
		externalId: profile.externalId,
		externalUsername: profile.username,
		externalEmail: profile.email,
	});

	const { token, expiresAt } = createSession(userId);
	setSessionCookie(cookies, token, expiresAt);

	throw redirect(302, '/');
}

async function handleJoin(args: {
	provider: OAuthProvider;
	cookies: Cookies;
	code: string | null;
	state: string | null;
	loginState: string | undefined;
	codeVerifier: string | null;
	joinCarrySigned: string;
}): Promise<never> {
	const { provider, cookies, code, state, loginState, codeVerifier, joinCarrySigned } = args;

	const carry = verify<JoinCarry>(joinCarrySigned);
	// No valid carry → can't know which invite this was; bounce to login.
	if (!carry) throw redirect(302, '/login?error=invalid_oauth_state');
	const inviteToken = carry.inviteToken;

	function joinError(reason: string): never {
		throw redirect(
			302,
			`/join/${encodeURIComponent(inviteToken)}?error=${encodeURIComponent(reason)}`,
		);
	}

	if (!code || !state || !loginState || state !== loginState) {
		joinError('invalid_oauth_state');
	}

	// Re-validate the invite at consume time (it may have expired or been
	// redeemed during the provider round-trip).
	const invite = findValidInvite(carry.inviteToken);
	if (!invite) joinError('invite_invalid');

	const profile = await fetchProfileOr(
		provider,
		{
			oauthError: () => joinError('oauth_exchange_failed'),
			upstreamError: () => joinError('upstream_failure'),
		},
		code,
		codeVerifier,
	);

	// This identity must not already belong to an account — a binding is
	// globally unique, and a user can't join twice.
	if (findUserByOAuth(provider.id, profile.externalId)) {
		joinError('already_registered');
	}

	let userId: string;
	try {
		userId = finalizeOAuthJoin({
			inviteId: invite.id,
			role: invite.role,
			invitedByUserId: invite.createdByUserId,
			displayName: carry.displayName,
			email: carry.email ?? profile.email,
			oauth: {
				provider: provider.id,
				externalId: profile.externalId,
				externalUsername: profile.username,
				externalEmail: profile.email,
			},
		});
	} catch (e) {
		// The transaction rolled back, so no account was created. Map the two
		// expected races precisely and don't mislabel anything else:
		//   - invite consumed by a parallel redemption -> invalid invite;
		//   - the identity got bound between the pre-check and the insert
		//     (UNIQUE conflict) -> genuinely already-registered.
		// Anything else is unexpected — log it and show a generic, retryable
		// error rather than claiming "already registered".
		if (e instanceof InviteConsumedError) joinError('invite_invalid');
		if (e instanceof Error && /UNIQUE constraint/i.test(e.message)) joinError('already_registered');
		console.error(`[auth/join] unexpected error finalizing ${provider.id} join:`, e);
		joinError('signup_failed');
	}

	const { token, expiresAt } = createSession(userId);
	setSessionCookie(cookies, token, expiresAt);

	throw redirect(302, '/');
}

async function handleLink(args: {
	provider: OAuthProvider;
	locals: App.Locals;
	code: string | null;
	state: string | null;
	linkState: string;
	codeVerifier: string | null;
}): Promise<never> {
	const { provider, locals, code, state, linkState, codeVerifier } = args;

	if (!locals.user) {
		// Session expired mid-flow. Bounce to login; nothing to bind to.
		throw redirect(302, '/login');
	}
	if (!code || !state || state !== linkState) {
		linkBack('invalid_state');
	}

	const profile = await fetchProfileOr(
		provider,
		{
			oauthError: () => linkBack('exchange_failed'),
			upstreamError: () => linkBack('upstream_failure'),
		},
		code,
		codeVerifier,
	);

	if (findUserByOAuth(provider.id, profile.externalId)) {
		linkBack('already_linked');
	}

	addOAuthAccount({
		userId: locals.user.id,
		provider: provider.id,
		externalId: profile.externalId,
		externalUsername: profile.username,
		externalEmail: profile.email,
	});

	linkBack('success');
}

async function handleLogin(args: {
	provider: OAuthProvider;
	cookies: Cookies;
	code: string | null;
	state: string | null;
	loginState: string | undefined;
	codeVerifier: string | null;
}): Promise<never> {
	const { provider, cookies, code, state, loginState, codeVerifier } = args;

	if (!code || !state || !loginState || state !== loginState) {
		loginError('invalid_oauth_state');
	}

	const profile = await fetchProfileOr(
		provider,
		{
			oauthError: () => loginError('oauth_exchange_failed'),
			upstreamError: () => loginError('upstream_failure'),
		},
		code,
		codeVerifier,
	);
	const externalId = profile.externalId;
	const binding = findUserByOAuth(provider.id, externalId);

	if (!binding) {
		if (countUsers() === 0) {
			console.warn(
				`[oauth/callback] Rejecting ${provider.id} user "${profile.username ?? externalId}" — no operator account exists yet`,
			);
			loginError('setup_required');
		}
		console.warn(
			`[oauth/callback] Rejecting ${provider.id} user "${profile.username ?? externalId}" — not bound to any account`,
		);
		loginError('provider_not_bound');
	}

	if (binding.disabledAt !== null) {
		console.warn(
			`[oauth/callback] Rejecting ${provider.id} user "${profile.username ?? externalId}" — bound user is disabled`,
		);
		loginError('not_authorized');
	}

	touchOAuthAccount(provider.id, externalId, {
		externalUsername: profile.username,
		externalEmail: profile.email,
	});
	bumpUserLastLogin(binding.userId);

	const { token, expiresAt } = createSession(binding.userId);
	setSessionCookie(cookies, token, expiresAt);

	throw redirect(302, '/');
}
