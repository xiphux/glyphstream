/**
 * GET /api/auth/github/callback — GitHub's OAuth landing point. Kept at
 * this legacy path (rather than the generic /api/auth/oauth/github/callback)
 * so existing operators' registered GitHub OAuth-app callback URL keeps
 * working with no reconfiguration. All the logic lives in the shared
 * handler; this just supplies the github provider.
 */
import { getProvider } from '$lib/server/auth/oauth/registry';
import { handleOAuthCallback } from '$lib/server/auth/oauth/callback-handler';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies, locals }) => {
	await handleOAuthCallback(getProvider('github')!, { url, cookies, locals });
	return new Response(); // unreachable — handleOAuthCallback always throws redirect
};
