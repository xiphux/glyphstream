/**
 * Per-user MCP credential management:
 *   PUT    /api/mcp/servers/[id]/credential  { token }  — set/replace
 *   DELETE /api/mcp/servers/[id]/credential             — clear
 *
 * Only valid for servers declared `auth = "per_user"` in config.toml. After a
 * change we drop any live connection for this (user, server) so the next use
 * reconnects with the new token; PUT then re-handshakes so the page can show
 * whether the token actually works and (on success) register the user's tools.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { dropUserConnection, getMcpServerCfg, retryMcpServer } from '$lib/server/mcp/registry';
import { deleteMcpCredential, setMcpCredential } from '$lib/server/db/queries/mcp-credentials';
import type { RequestHandler } from './$types';

function requirePerUserServer(id: string): void {
	const cfg = getMcpServerCfg(id);
	if (!cfg) throw error(404, 'Unknown MCP server');
	if (cfg.auth !== 'per_user') {
		throw error(400, 'This MCP server does not use per-user credentials');
	}
}

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
	const id = params.id;
	requirePerUserServer(id);

	const body = await parseJsonBody<{ token?: unknown }>(request);
	const token = typeof body.token === 'string' ? body.token.trim() : '';
	if (!token) throw error(400, 'A non-empty token is required');

	setMcpCredential(locals.user.id, id, token);
	// Drop any stale connection so the re-handshake uses the new token.
	await dropUserConnection(id, locals.user.id);
	const result = await retryMcpServer(id, locals.user.id);
	return json({ state: result.state, error: result.error });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const id = params.id;
	requirePerUserServer(id);

	const existed = deleteMcpCredential(locals.user.id, id);
	await dropUserConnection(id, locals.user.id);
	return json({ ok: true, existed });
};
