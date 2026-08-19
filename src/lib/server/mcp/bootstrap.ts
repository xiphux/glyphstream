/**
 * MCP bootstrap. `bootstrapMcp()` kicks off the eager connect at module
 * load time (called from hooks.server.ts); `awaitMcpReady()` lets per-
 * request paths block on the first init promise so they don't advertise
 * an empty MCP-tool surface during the cold-start window. After the
 * first call, both functions return the same memoized promise.
 *
 * Bootstrap failures don't reject — they're logged and resolve. A failed
 * MCP server appears in `/settings/mcp` as `state: 'failed'`; one bad
 * server must never wedge boot or block subsequent requests.
 */

import { initializeMcpServers } from './registry';
import { registerAllMcpTools } from './tool-bridge';

let readyPromise: Promise<void> | null = null;
let settled = false;

export function bootstrapMcp(): Promise<void> {
	if (readyPromise) return readyPromise;
	readyPromise = (async () => {
		try {
			await initializeMcpServers();
			registerAllMcpTools();
		} catch (err) {
			// Config-parse errors and other surprises end up here. Log and
			// swallow — the app should still boot with MCP disabled.
			console.error('[mcp] bootstrap failed:', err);
		} finally {
			// In the `finally` so a bootstrap that threw still counts as settled:
			// isMcpReady answers "is the registry done changing", not "did it
			// succeed". A failed bootstrap is done changing.
			settled = true;
		}
	})();
	return readyPromise;
}

/**
 * Block until bootstrap has fully settled. For paths where the MCP surface is
 * part of the ANSWER: the send path's `tools[]`, the tool-approval handler,
 * and the two settings pages that report per-server state. Those must not
 * observe a half-connected registry — a `tools[]` that changes because a
 * handshake landed mid-conversation is exactly the payload-prefix churn
 * CLAUDE.md warns about.
 *
 * NOT for render paths. See isMcpReady.
 */
export function awaitMcpReady(): Promise<void> {
	return readyPromise ?? bootstrapMcp();
}

/**
 * Has bootstrap finished, synchronously? Lets a render path take the registry
 * as it stands and tell the client whether to expect it to change.
 *
 * The `(app)` layout used to `await awaitMcpReady()`, which put every global
 * server's handshake in front of the first page render after a process start
 * — and for a remote HTTP server that is a live network round trip to a third
 * party, unbounded, on the critical path of the first thing the user sees.
 *
 * What that wait bought is much smaller than it looks: `listServerCatalog()`
 * reads `serverConfigs`, which `initializeMcpServers` fills SYNCHRONOUSLY
 * before it connects to anything. So ids, names and transports are already
 * correct the moment bootstrap starts. Only two fields need the connects:
 * `toolCount` (documented as cosmetic) and `available`, which hides a global
 * server whose boot connect failed. So the layout renders immediately and
 * reports `mcpSettled: false`; the client waits for /api/mcp/ready off the
 * critical path and re-pulls the layout data once, which is where those two
 * fields become accurate.
 *
 * False only inside the cold-start window. Every later navigation sees true
 * and the client does nothing at all.
 */
export function isMcpReady(): boolean {
	return settled;
}

/** Test-only — reset the bootstrap promise so suites can re-init. */
export function _resetMcpBootstrapForTests(): void {
	readyPromise = null;
	settled = false;
}
