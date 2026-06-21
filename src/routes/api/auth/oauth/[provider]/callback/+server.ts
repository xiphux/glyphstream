/**
 * GET /api/auth/oauth/:provider/callback — the OAuth landing point for
 * every provider EXCEPT github (which keeps its legacy
 * /api/auth/github/callback). Delegates to the shared handler.
 *
 * Guards against serving a provider whose registered callback path isn't
 * this route — chiefly github, whose `callbackPath` is the legacy path, so
 * it must never be double-served here.
 */
import { error } from '@sveltejs/kit';
import { getProvider } from '$lib/server/auth/oauth/registry';
import { handleOAuthCallback } from '$lib/server/auth/oauth/callback-handler';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies, locals, params }) => {
	const provider = getProvider(params.provider);
	if (!provider || provider.callbackPath !== `/api/auth/oauth/${params.provider}/callback`) {
		throw error(404, 'Unknown provider');
	}
	await handleOAuthCallback(provider, { url, cookies, locals });
	return new Response(); // unreachable — handleOAuthCallback always throws redirect
};
