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
		}
	})();
	return readyPromise;
}

export function awaitMcpReady(): Promise<void> {
	return readyPromise ?? bootstrapMcp();
}

/** Test-only — reset the bootstrap promise so suites can re-init. */
export function _resetMcpBootstrapForTests(): void {
	readyPromise = null;
}
