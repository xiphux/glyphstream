import { redirect } from '@sveltejs/kit';
import { generateState } from 'arctic';
import { getGithubClient, STATE_COOKIE, STATE_TTL_SECONDS } from '$lib/server/auth/github';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ cookies }) => {
	const state = generateState();
	const client = getGithubClient();
	const url = client.createAuthorizationURL(state, ['read:user', 'user:email']);

	cookies.set(STATE_COOKIE, state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: STATE_TTL_SECONDS,
	});

	throw redirect(302, url.toString());
};
