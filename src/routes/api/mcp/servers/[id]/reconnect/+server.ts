/**
 * POST: force a fresh handshake against `[id]`'s configured MCP server.
 * Drives the "Retry" button on /settings/mcp so users can recover from a
 * boot-time failure without restarting the process. On success we also
 * register the server's tools into the main tool registry so the LLM
 * can see them this conversation.
 */

import { error, json } from '@sveltejs/kit';
import { getMcpServerCfg, retryMcpServer } from '$lib/server/mcp/registry';
import { registerMcpServerTools } from '$lib/server/mcp/tool-bridge';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Sign in to continue.');
	const id = params.id;
	if (!id) throw error(400, 'Missing server id in path');

	let result;
	try {
		result = await retryMcpServer(id, locals.user.id);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.startsWith('mcp: unknown server')) throw error(404, msg);
		throw err;
	}

	// Re-register a GLOBAL server's tools on success so the LLM sees them this
	// conversation. Per-user servers' tools are (re)registered per request by
	// the message/tool-approval handlers (availability is per user), so there's
	// nothing to register globally here.
	if (result.state === 'connected' && getMcpServerCfg(id)?.auth === 'global') {
		registerMcpServerTools(id);
	}

	return json({ state: result.state, error: result.error });
};
