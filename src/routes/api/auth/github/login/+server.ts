import { redirect } from '@sveltejs/kit';
import { generateState } from 'arctic';
import { getGithubClient } from '$lib/server/auth/github';
import type { RequestHandler } from './$types';

const STATE_COOKIE = 'glyphstream_oauth_state';
const STATE_TTL_SECONDS = 600;

export const GET: RequestHandler = ({ cookies }) => {
	const state = generateState();
	const client = getGithubClient();
	const url = client.createAuthorizationURL(state, ['read:user', 'user:email']);

	cookies.set(STATE_COOKIE, state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: STATE_TTL_SECONDS
	});

	throw redirect(302, url.toString());
};
