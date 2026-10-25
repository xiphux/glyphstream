/**
 * Before a scheduled run starts: are the MCP servers its policy relies on up?
 *
 * A chat turn tolerates a down server — the user is there, sees the "tools
 * skipped" notice, and can retry. A scheduled run has nobody watching, so a
 * morning brief that silently ran without the mail server would be a confident
 * summary of nothing. So a run checks first, gives each server one real
 * reconnect (the send path's circuit breaker would otherwise keep a server that
 * blipped yesterday marked failed forever), and fails with a reason the
 * notification can name if a server still isn't there.
 */
import type {
	FeatureCategory,
	ScheduledRunFailureKind,
	ScheduledToolPolicy,
} from '#lib/types/api.js';
import { awaitMcpReady } from '../mcp/bootstrap';
import { getUserServerStates, retryMcpServer, type UserServerState } from '../mcp/registry';

/** How long a run waits for a server's handshake. Generous next to the send
 *  path's 2.5s: nobody is waiting on this one, and a cold server is common at
 *  07:00. */
const PREFLIGHT_CONNECT_BUDGET_MS = 20_000;

export type PreflightResult =
	| { ok: true }
	| {
			ok: false;
			kind: Extract<ScheduledRunFailureKind, 'mcp_unavailable' | 'mcp_credentials'>;
			detail: string;
	  };

/** The server ids a policy's MCP tools belong to (`mcp__<server>__<tool>`;
 *  server ids can't contain `__`). */
export function serversInPolicy(policy: ScheduledToolPolicy): string[] {
	const ids = new Set<string>();
	for (const name of [...policy.allowed, ...policy.ask]) {
		const m = /^mcp__(.+?)__/.exec(name);
		if (m) ids.add(m[1]);
	}
	return [...ids].sort();
}

export async function preflightMcp(
	userId: string,
	policy: ScheduledToolPolicy,
	disabledFeatures: readonly FeatureCategory[],
): Promise<PreflightResult> {
	// A server the run's own opt-outs switch off is one it isn't going to use.
	const needed = serversInPolicy(policy).filter((id) => !disabledFeatures.includes(`mcp:${id}`));
	if (needed.length === 0) return { ok: true };

	await awaitMcpReady();
	// No `skipFailed`: a failed per-user server gets a fresh connect here.
	let states = await getUserServerStates(userId, {
		excludeCategories: disabledFeatures,
		connectBudgetMs: PREFLIGHT_CONNECT_BUDGET_MS,
	});
	const byId = () => new Map(states.map((s) => [s.id, s]));

	// Global servers aren't reconnected by the call above (they're shared, and
	// only `ensureConnected` on use or the settings retry touches them) — retry
	// a failed one once.
	const failedGlobal = needed.filter((id) => {
		const s = byId().get(id);
		return s?.auth === 'global' && s.state === 'failed';
	});
	if (failedGlobal.length > 0) {
		await Promise.all(failedGlobal.map((id) => retryMcpServer(id, userId).catch(() => {})));
		states = await getUserServerStates(userId, {
			excludeCategories: disabledFeatures,
			connectBudgetMs: PREFLIGHT_CONNECT_BUDGET_MS,
		});
	}

	const current = byId();
	for (const id of needed) {
		const s = current.get(id);
		if (!s) {
			return {
				ok: false,
				kind: 'mcp_unavailable',
				detail: `MCP server "${id}" is no longer configured`,
			};
		}
		const problem = describe(s);
		if (problem) return { ok: false, ...problem };
	}
	return { ok: true };
}

function describe(s: UserServerState): Omit<Extract<PreflightResult, { ok: false }>, 'ok'> | null {
	switch (s.state) {
		case 'connected':
		case 'idle':
			return null;
		case 'needs-credential':
			return {
				kind: 'mcp_credentials',
				detail: `${s.displayName} needs your token — add it in Settings → MCP servers`,
			};
		case 'failed':
			// The registry keeps only the connect error's text, so a rejected token
			// can't be told apart structurally. Read it loosely: the cost of a miss
			// is the generic "unreachable" wording, not a wrong outcome.
			if (
				s.auth === 'per_user' &&
				s.error &&
				/\b40[13]\b|unauthori[sz]ed|forbidden/i.test(s.error)
			) {
				return {
					kind: 'mcp_credentials',
					detail: `${s.displayName} rejected your token — update it in Settings → MCP servers`,
				};
			}
			return {
				kind: 'mcp_unavailable',
				detail: `${s.displayName} is unreachable${s.error ? `: ${s.error}` : ''}`,
			};
		case 'reconnecting':
			return { kind: 'mcp_unavailable', detail: `${s.displayName} didn't connect in time` };
	}
}
