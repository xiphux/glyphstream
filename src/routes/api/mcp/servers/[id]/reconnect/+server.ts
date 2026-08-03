/**
 * POST: force a fresh handshake against `[id]`'s configured MCP server.
 * Drives the "Retry" button on /settings/mcp so users can recover from a
 * boot-time failure without restarting the process. On success we also
 * register the server's tools into the main tool registry so the LLM
 * can see them this conversation.
 */

import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { getMcpServerCfg, retryMcpServer } from '$lib/server/mcp/registry';
import { registerMcpServerTools } from '$lib/server/mcp/tool-bridge';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const id = params.id;
	if (!id) throw error(400, 'Missing server id in path');

	// A `global` server has ONE process-wide connection that every user
	// shares, and retry closes it before re-handshaking. Any signed-in user
	// could therefore drop everyone else's connection — and loop it to break
	// other users' in-flight tool calls. Retrying a per_user server only
	// touches the caller's own connection, so that stays open to its owner.
	const cfg = getMcpServerCfg(id);
	const isGlobal = cfg?.auth !== 'per_user';
	if (isGlobal && locals.user.role !== 'admin') {
		throw error(403, 'Only an administrator can reconnect a shared MCP server');
	}

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

	// A global server's handshake error describes operator-configured
	// infrastructure — upstream host, port, HTTP status. Only an admin, who
	// can already read config.toml, gets the detail; the caller of a per_user
	// retry is looking at their own credential, so that passes through.
	const detail = isGlobal && locals.user.role !== 'admin' ? 'Connection failed' : result.error;
	return json({ state: result.state, error: detail });
};
