import { loadMcpServers, type LoadedMcpServer } from './config';
import {
	connectMcpServer,
	type McpConnection,
	type McpToolDescriptor,
	type McpCallResult,
} from './client';

interface ConnectedEntry {
	state: 'connected';
	cfg: LoadedMcpServer;
	client: McpConnection;
	tools: McpToolDescriptor[];
	lastUsedAt: number;
	idleTimerId: ReturnType<typeof setTimeout> | null;
}

interface IdleEntry {
	state: 'idle';
	cfg: LoadedMcpServer;
	tools: McpToolDescriptor[];
}

interface FailedEntry {
	state: 'failed';
	cfg: LoadedMcpServer;
	error: string;
}

interface ReconnectingEntry {
	state: 'reconnecting';
	cfg: LoadedMcpServer;
	tools: McpToolDescriptor[] | null;
	promise: Promise<ConnectedEntry | FailedEntry>;
}

type Entry = ConnectedEntry | IdleEntry | FailedEntry | ReconnectingEntry;

const entries = new Map<string, Entry>();
let initPromise: Promise<void> | null = null;
let shutdownInstalled = false;

/**
 * Idempotent eager initialization. Loads `[[mcp_servers]]`, connects to each
 * in parallel, fetches each server's tool list, and records the result.
 * Connection failures are non-fatal — they surface in `/settings/mcp` and
 * the affected server's tools are simply absent from the registry.
 */
export function initializeMcpServers(): Promise<void> {
	if (initPromise) return initPromise;
	installShutdownHook();
	initPromise = (async () => {
		let servers: LoadedMcpServer[];
		try {
			servers = loadMcpServers();
		} catch (err) {
			// Config-parse failures are loud — same as endpoints. Re-throw so
			// the boot stops with a clear error rather than silently disabling
			// MCP for the lifetime of the process.
			throw err;
		}
		await Promise.all(servers.map((s) => connectAndRecord(s, /* firstTime */ true)));
	})();
	return initPromise;
}

/** Returns the loaded config for a server, or undefined if it isn't registered. */
export function getMcpServerCfg(serverId: string): LoadedMcpServer | undefined {
	return entries.get(serverId)?.cfg;
}

/** Returns all configured servers in declaration order, alive or otherwise. */
export function listMcpServerStates(): ReadonlyArray<{
	id: string;
	displayName: string;
	transport: 'stdio' | 'http';
	state: 'connected' | 'idle' | 'failed' | 'reconnecting';
	error?: string;
	tools: McpToolDescriptor[];
}> {
	return Array.from(entries.values()).map((e) => ({
		id: e.cfg.id,
		displayName: e.cfg.displayName,
		transport: e.cfg.transport,
		state: e.state,
		error: e.state === 'failed' ? e.error : undefined,
		tools: e.state === 'failed' ? [] : (e.tools ?? []),
	}));
}

/**
 * Returns the tools advertised by `serverId` regardless of current
 * connection state. Used by the tool-bridge during bootstrap to register
 * each server's tools into the main tool registry.
 */
export function getMcpServerTools(serverId: string): McpToolDescriptor[] {
	const e = entries.get(serverId);
	if (!e || e.state === 'failed') return [];
	if (e.state === 'reconnecting' && e.tools === null) return [];
	return e.tools ?? [];
}

/**
 * Per-call entry point used by MCP-bridge tools' execute(). Ensures the
 * server is connected (reconnecting on demand), invokes the tool with the
 * caller's abort signal + per-server timeout, and retries exactly once on
 * a transport-drop error before propagating the failure to the model.
 */
export async function callMcpTool(
	serverId: string,
	toolName: string,
	args: unknown,
	signal: AbortSignal,
): Promise<McpCallResult> {
	const cfg = entries.get(serverId)?.cfg;
	if (!cfg) throw new Error(`mcp: unknown server "${serverId}"`);
	const timeoutMs = cfg.timeoutSeconds * 1000;

	const conn = await ensureConnected(serverId);
	try {
		const result = await conn.callTool(toolName, args, signal, timeoutMs);
		markActive(serverId);
		return result;
	} catch (err) {
		if (signal.aborted) throw err;
		markIdle(serverId);
		const conn2 = await ensureConnected(serverId);
		const result = await conn2.callTool(toolName, args, signal, timeoutMs);
		markActive(serverId);
		return result;
	}
}

/**
 * Force a fresh connection attempt for `serverId`, regardless of its
 * current state. Used by the `/settings/mcp` retry button so users have
 * a recovery path when the boot handshake landed in `failed` and there
 * are no tools registered to drive `ensureConnected` from a tool call.
 *
 * Tears down any live connection first — the SDK's StreamableHTTP
 * transport caches the session ID internally with no public reset, so
 * recreating the Client + transport is the only way to clear it.
 */
export async function retryMcpServer(serverId: string): Promise<{
	state: 'connected' | 'failed';
	error: string | null;
}> {
	const entry = entries.get(serverId);
	if (!entry) throw new Error(`mcp: unknown server "${serverId}"`);
	if (entry.state === 'reconnecting') {
		const settled = await entry.promise;
		return summarizeSettled(settled);
	}
	if (entry.state === 'connected') {
		if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
		await entry.client.close().catch(() => {});
	}
	const settled = await connectAndRecord(entry.cfg, /* firstTime */ false);
	return summarizeSettled(settled);
}

function summarizeSettled(e: ConnectedEntry | FailedEntry): {
	state: 'connected' | 'failed';
	error: string | null;
} {
	return e.state === 'connected'
		? { state: 'connected', error: null }
		: { state: 'failed', error: e.error };
}

async function ensureConnected(serverId: string): Promise<McpConnection> {
	const entry = entries.get(serverId);
	if (!entry) throw new Error(`mcp: unknown server "${serverId}"`);

	if (entry.state === 'connected') return entry.client;
	if (entry.state === 'reconnecting') {
		const settled = await entry.promise;
		if (settled.state === 'failed') {
			throw new Error(`mcp: server "${serverId}" failed to connect: ${settled.error}`);
		}
		return settled.client;
	}
	if (entry.state === 'failed') {
		// Boot-time failure. Retry on demand — gives us free recovery if the
		// upstream came up later. The next attempt either promotes the
		// server to connected or stays failed with a fresh error string.
		const settled = await connectAndRecord(entry.cfg, /* firstTime */ false);
		if (settled.state === 'failed') {
			throw new Error(`mcp: server "${serverId}" still failing: ${settled.error}`);
		}
		return settled.client;
	}
	// state === 'idle' — reaped or transport-dropped. Reconnect.
	const settled = await connectAndRecord(entry.cfg, /* firstTime */ false, entry.tools);
	if (settled.state === 'failed') {
		throw new Error(`mcp: reconnect for "${serverId}" failed: ${settled.error}`);
	}
	return settled.client;
}

async function connectAndRecord(
	cfg: LoadedMcpServer,
	firstTime: boolean,
	existingTools: McpToolDescriptor[] | null = null,
): Promise<ConnectedEntry | FailedEntry> {
	// Coalesce concurrent attempts: install a reconnecting entry whose promise
	// every concurrent caller awaits.
	const reconnecting: ReconnectingEntry = {
		state: 'reconnecting',
		cfg,
		tools: existingTools,
		promise: doConnect(cfg, firstTime, existingTools),
	};
	entries.set(cfg.id, reconnecting);
	const settled = await reconnecting.promise;
	// Only replace if the current entry is still the same reconnecting
	// instance — guards against races with a concurrent reaper or shutdown.
	if (entries.get(cfg.id) === reconnecting) {
		entries.set(cfg.id, settled);
		if (settled.state === 'connected') scheduleIdleReap(cfg.id);
	}
	return settled;
}

async function doConnect(
	cfg: LoadedMcpServer,
	firstTime: boolean,
	existingTools: McpToolDescriptor[] | null,
): Promise<ConnectedEntry | FailedEntry> {
	const timeoutMs = cfg.timeoutSeconds * 1000;
	try {
		const client = await connectMcpServer(cfg, timeoutMs);
		// connectMcpServer enforces its own timeout on the handshake but
		// listTools has none — a server that completes the handshake and
		// then never responds to the tools/list request would otherwise
		// hang awaitMcpReady() (and the layout load that awaits it)
		// forever. Race against the same per-server budget.
		const tools =
			firstTime || existingTools === null
				? await withTimeout(client.listTools(), timeoutMs, `${cfg.id} listTools`)
				: existingTools;
		client.onClose(() => markIdle(cfg.id));
		return {
			state: 'connected',
			cfg,
			client,
			tools,
			lastUsedAt: Date.now(),
			idleTimerId: null,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (firstTime) {
			console.warn(`[mcp] failed to connect to "${cfg.id}": ${msg}`);
		}
		return { state: 'failed', cfg, error: msg };
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

function scheduleIdleReap(serverId: string): void {
	const entry = entries.get(serverId);
	if (!entry || entry.state !== 'connected') return;
	if (entry.cfg.transport !== 'stdio') return; // HTTP keeps no expensive state
	if (entry.cfg.idleTimeoutSeconds <= 0) return;
	if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
	const ms = entry.cfg.idleTimeoutSeconds * 1000;
	entry.idleTimerId = setTimeout(() => reapIfIdle(serverId), ms);
	// Don't keep the event loop alive for an idle reaper.
	if (typeof entry.idleTimerId === 'object' && entry.idleTimerId && 'unref' in entry.idleTimerId) {
		(entry.idleTimerId as { unref: () => void }).unref();
	}
}

function reapIfIdle(serverId: string): void {
	const entry = entries.get(serverId);
	if (!entry || entry.state !== 'connected') return;
	const idleMs = entry.cfg.idleTimeoutSeconds * 1000;
	const elapsed = Date.now() - entry.lastUsedAt;
	if (elapsed < idleMs) {
		// A call landed between schedule and fire. Reschedule for the remainder.
		entry.idleTimerId = null;
		scheduleIdleReap(serverId);
		return;
	}
	const idleEntry: IdleEntry = { state: 'idle', cfg: entry.cfg, tools: entry.tools };
	entries.set(serverId, idleEntry);
	entry.client.close().catch(() => {});
}

function markActive(serverId: string): void {
	const entry = entries.get(serverId);
	if (entry?.state === 'connected') {
		entry.lastUsedAt = Date.now();
		scheduleIdleReap(serverId);
	}
}

function markIdle(serverId: string): void {
	const entry = entries.get(serverId);
	if (!entry) return;
	if (entry.state === 'connected') {
		if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
		entries.set(serverId, { state: 'idle', cfg: entry.cfg, tools: entry.tools });
		entry.client.close().catch(() => {});
	}
}

function installShutdownHook(): void {
	if (shutdownInstalled) return;
	shutdownInstalled = true;
	const close = async () => {
		await Promise.all(
			Array.from(entries.values()).map(async (e) => {
				if (e.state === 'connected') await e.client.close().catch(() => {});
			}),
		);
	};
	process.on('SIGINT', () => {
		void close();
	});
	process.on('SIGTERM', () => {
		void close();
	});
	process.on('beforeExit', () => {
		void close();
	});
}

/**
 * Reset all in-process MCP state. Test-only — production code should never
 * call this. Closes any live connections, clears every entry, resets the
 * one-shot init guard.
 */
export async function resetMcpRegistryForTests(): Promise<void> {
	for (const e of entries.values()) {
		if (e.state === 'connected') {
			if (e.idleTimerId) clearTimeout(e.idleTimerId);
			await e.client.close().catch(() => {});
		}
	}
	entries.clear();
	initPromise = null;
}
