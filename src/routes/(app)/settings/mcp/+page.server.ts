import { error } from '@sveltejs/kit';
import { awaitMcpReady } from '$lib/server/mcp/bootstrap';
import { getUserServerStates } from '$lib/server/mcp/registry';
import { buildRegisteredName } from '$lib/server/mcp/tool-bridge';
import type { PageServerLoad } from './$types';

/**
 * How long this page will wait on MCP handshakes before rendering. Much longer
 * than the send path's budget — here the connection state IS the content, so
 * it's worth waiting for — but bounded, so an unreachable server can't hold the
 * page for the full connect + list-tools timeout (60s at the defaults).
 */
const MCP_SETTINGS_CONNECT_BUDGET_MS = 10_000;

export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	// Prefs come from the (app) layout, which already loaded them — see the note
	// in settings/preferences.
	const { prefs } = await parent();
	if (!locals.user) error(401, 'Authentication required');
	// Tagged so the page can `invalidate('settings:mcp')` after a retry, a
	// credential change, or a trust toggle without re-running the (app) layout.
	depends('settings:mcp');
	await awaitMcpReady();
	// Surface the user's trusted-tools list here too so each tool row can show
	// its current grant state — letting the user pre-allow tools without
	// waiting for the first invocation's approval card.
	const trusted = new Set(prefs?.trustedMcpTools ?? []);
	// Per-user states: global servers report the shared connection; per-user
	// servers report this user's connection (or `needs-credential`).
	//
	// Budgeted, unlike before. This page deliberately does NOT `skipFailed` — the
	// whole point of visiting it is to find out whether a server is reachable
	// now, so re-attempting a failed one is the feature. But with no budget at
	// all, `connectMcpServer` and then `listTools` each get the full
	// `timeout_seconds` (30 by default), so one black-holing server held the page
	// for up to a minute before anything rendered. A soft deadline renders
	// whatever resolved and leaves the rest connecting in the background; the
	// page already has a retry control and an `invalidate('settings:mcp')` to
	// pick them up.
	const states = await getUserServerStates(locals.user.id, {
		connectBudgetMs: MCP_SETTINGS_CONNECT_BUDGET_MS,
	});
	return {
		// Retrying a `global` server closes the one connection every user
		// shares, so the API restricts it to admins. Surface the role here so
		// the page can hide a button that would only ever 403.
		isAdmin: locals.user.role === 'admin',
		servers: states.map((s) => ({
			id: s.id,
			displayName: s.displayName,
			transport: s.transport,
			auth: s.auth,
			perUser: s.auth === 'per_user',
			configured: s.configured,
			state: s.state,
			error: s.error ?? null,
			tools: s.tools.map((t) => {
				const registeredName = buildRegisteredName(s.id, t.name);
				return {
					name: t.name,
					registeredName,
					description: t.description ?? '',
					trusted: trusted.has(registeredName),
				};
			}),
		})),
	};
};
