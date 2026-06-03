/**
 * POST /api/auth/oauth/:provider/link/start — kick off a session-
 * attached OAuth round-trip whose callback binds the resulting profile
 * to the *current* user (rather than looking up an existing binding).
 * Uses a separate state cookie from the login flow so a tab swap can't
 * confuse the two paths.
 */
import { error, redirect } from '@sveltejs/kit';
import { generateState } from 'arctic';
import { requireUser } from '$lib/server/auth/guard';
import { getGithubClient, LINK_STATE_COOKIE, STATE_TTL_SECONDS } from '$lib/server/auth/github';
import { githubLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, cookies, params }) => {
	requireUser(locals);
	if (params.provider !== 'github') throw error(404, 'Unknown provider');
	if (!githubLoginEnabled()) throw error(403, 'GitHub login is disabled');

	const state = generateState();
	const client = getGithubClient();
	const url = client.createAuthorizationURL(state, ['read:user', 'user:email']);

	cookies.set(LINK_STATE_COOKIE, state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: STATE_TTL_SECONDS,
	});

	throw redirect(302, url.toString());
};
