import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMcpServers, type LoadedMcpServer, type McpAuthMode } from './config';
import {
	connectMcpServer,
	type McpConnection,
	type McpToolDescriptor,
	type McpCallResult,
} from './client';
import { getMcpCredential } from '../db/queries/mcp-credentials';

// --- connection keying ----------------------------------------------------
//
// Global servers (auth='global') share one connection across all users, keyed
// by server id alone. Per-user servers (auth='per_user') get one connection
// PER USER — keyed by `${serverId}\0${userId}` — each carrying that user's
// own credential. NUL can't appear in a server id (validated alphanumeric+dash),
// so the composite is unambiguous.
//
// Written as the ESCAPE `\0`, never as a literal NUL byte. A literal one makes
// git and grep classify this entire file as binary, and BSD grep then reports no
// matches at all rather than saying why — a silent, very confusing way to lose an
// hour. The escape is the same character at runtime; it just keeps the file text.
function keyFor(serverId: string, userId: string | null): string {
	return userId === null ? serverId : `${serverId}\0${userId}`;
}

interface ConnectedState {
	state: 'connected';
	cfg: LoadedMcpServer;
	client: McpConnection;
	tools: McpToolDescriptor[];
	lastUsedAt: number;
	idleTimerId: ReturnType<typeof setTimeout> | null;
}
interface IdleState {
	state: 'idle';
	cfg: LoadedMcpServer;
	tools: McpToolDescriptor[];
}
interface FailedState {
	state: 'failed';
	cfg: LoadedMcpServer;
	error: string;
}
interface ReconnectingState {
	state: 'reconnecting';
	cfg: LoadedMcpServer;
	tools: McpToolDescriptor[] | null;
	promise: Promise<Entry>;
}
type EntryState = ConnectedState | IdleState | FailedState | ReconnectingState;
type Entry = EntryState & { serverId: string; userId: string | null };

/** The configured-server catalog (all servers from config.toml, by id). The
 *  source of truth for which servers exist + their auth mode; connections live
 *  separately in `entries`. */
const serverConfigs = new Map<string, LoadedMcpServer>();

/** Live connection state, keyed by `keyFor(serverId, userId)`. Global servers
 *  use a null-user key; per-user servers one key per user. */
const entries = new Map<string, Entry>();

let initPromise: Promise<void> | null = null;

/**
 * Idempotent eager initialization. Loads the full `[[mcp_servers]]` catalog,
 * then connects ONLY the global servers at boot (per-user servers can't
 * connect without a user's credential — they connect lazily on first use).
 * Connection failures are non-fatal — they surface in `/settings/mcp`.
 */
export function initializeMcpServers(): Promise<void> {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		// Config-parse failures are loud — re-throw so boot stops with a clear
		// error rather than silently disabling MCP for the process lifetime.
		const servers = loadMcpServers();
		serverConfigs.clear();
		for (const s of servers) serverConfigs.set(s.id, s);

		const globals = servers.filter((s) => s.auth === 'global');
		await Promise.all(globals.map((s) => connectAndRecord(s, s.id, null, /* firstTime */ true)));
	})();
	return initPromise;
}

/** The configured server's catalog entry, or undefined if unknown. */
export function getMcpServerCfg(serverId: string): LoadedMcpServer | undefined {
	return serverConfigs.get(serverId);
}

export interface ServerCatalogEntry {
	id: string;
	displayName: string;
	transport: 'stdio' | 'http';
	auth: McpAuthMode;
	/** Best-known tool count (the global connection's, or 0 for a per-user
	 *  server before anyone connects). Cosmetic — for the feature-toggle label. */
	toolCount: number;
	/** Whether to surface this server as a feature category. Global servers
	 *  that failed at boot are hidden (as before); per-user servers always
	 *  show (failure is per-user/credential-specific, not a server fault). */
	available: boolean;
}

/**
 * The full configured-server catalog (sync). Drives the per-conversation
 * feature-category list — which is deliberately user-independent: a per-user
 * server appears as a toggle for everyone, but its tools are only advertised
 * /executed for users who've supplied a credential. So toggling it with no
 * credential is a harmless no-op.
 */
export function listServerCatalog(): ServerCatalogEntry[] {
	return Array.from(serverConfigs.values()).map((cfg) => {
		const globalEntry = cfg.auth === 'global' ? entries.get(keyFor(cfg.id, null)) : undefined;
		const toolCount =
			globalEntry && globalEntry.state !== 'failed' ? (globalEntry.tools?.length ?? 0) : 0;
		const available =
			cfg.auth === 'per_user' ? true : !globalEntry || globalEntry.state !== 'failed';
		return {
			id: cfg.id,
			displayName: cfg.displayName,
			transport: cfg.transport,
			auth: cfg.auth,
			toolCount,
			available,
		};
	});
}

/**
 * Tools advertised by a GLOBAL server, regardless of connection state. Used
 * by the tool-bridge at boot to register global servers' tools into the main
 * registry. Per-user servers' tools are registered/advertised per request
 * (see the tool-bridge + message handlers).
 */
export function getMcpServerTools(serverId: string): McpToolDescriptor[] {
	const e = entries.get(keyFor(serverId, null));
	if (!e || e.state === 'failed') return [];
	if (e.state === 'reconnecting' && e.tools === null) return [];
	return e.tools ?? [];
}

/** Server ids of all GLOBAL servers — the boot tool-registration set. */
export function listGlobalServerIds(): string[] {
	return Array.from(serverConfigs.values())
		.filter((s) => s.auth === 'global')
		.map((s) => s.id);
}

/**
 * Connection states of the GLOBAL servers (sync). Per-user servers are
 * excluded — their state is per user; use `getUserServerStates(userId)` for
 * those. Used wherever the shared servers' live state is needed without a
 * user context (and by the registry tests).
 */
export function listGlobalServerStates(): ReadonlyArray<{
	id: string;
	displayName: string;
	transport: 'stdio' | 'http';
	state: 'connected' | 'idle' | 'failed' | 'reconnecting';
	error?: string;
	tools: McpToolDescriptor[];
}> {
	return Array.from(serverConfigs.values())
		.filter((cfg) => cfg.auth === 'global')
		.map((cfg) => {
			const e = entries.get(keyFor(cfg.id, null));
			return {
				id: cfg.id,
				displayName: cfg.displayName,
				transport: cfg.transport,
				state: e?.state ?? 'idle',
				error: e?.state === 'failed' ? e.error : undefined,
				tools: e && e.state !== 'failed' ? (e.tools ?? []) : [],
			};
		});
}

export interface UserServerState {
	id: string;
	displayName: string;
	transport: 'stdio' | 'http';
	auth: McpAuthMode;
	state: 'connected' | 'idle' | 'failed' | 'reconnecting' | 'needs-credential';
	error: string | null;
	tools: McpToolDescriptor[];
	/** per-user: whether the user has supplied a credential. Always true for
	 *  global servers. */
	configured: boolean;
}

/**
 * Resolve when `p` settles OR `ms` elapses, whichever is first — and never
 * reject. A connect that overruns the budget keeps running in the background
 * (its result still lands in the registry for the next turn); we just stop
 * waiting on it. The settle handlers swallow a late rejection so it can't
 * surface as an unhandled rejection after we've already moved on.
 *
 * Exported for unit testing; not part of the registry's public surface.
 */
export function withSoftDeadline(p: Promise<unknown>, ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		p.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			() => {
				clearTimeout(timer);
				resolve();
			},
		);
	});
}

export interface ServerStatesOptions {
	/** Per-conversation feature opt-outs. A per-user server whose `mcp:<id>`
	 *  category is disabled for this conversation is NOT connected at all — its
	 *  tools get filtered out downstream regardless, so paying its handshake on
	 *  send is pure waste (and was why an all-MCP-off chat still stalled on a
	 *  dead server). */
	excludeCategories?: readonly string[];
	/** Circuit-breaker: don't re-attempt a per-user server already in `failed`
	 *  state. A down server otherwise burns its full connect timeout on EVERY
	 *  message (ensureConnected retries `failed` on demand). Skipped here; the
	 *  user re-arms it via the /settings/mcp retry button. */
	skipFailed?: boolean;
	/** Per-connect wait budget (ms). A connect that overruns is left to finish
	 *  in the background while we proceed — so one slow-but-up server can't hold
	 *  the whole send. Omit to await the full handshake (settings page). */
	connectBudgetMs?: number;
}

/**
 * Per-user view of every configured server, for the settings + permissions
 * pages AND the latency-sensitive message-send path. Global servers report
 * their shared connection; per-user servers report this user's connection
 * (connecting on demand when a credential exists) or `needs-credential` when
 * the user hasn't supplied a token yet.
 *
 * With no `opts` the settings page gets its eager "connect everything, retry
 * failures, wait the full handshake" behavior (it needs an accurate live
 * status view). The send path passes `opts` to gate by conversation, circuit-
 * break failed servers, and bound the wait — see {@link ServerStatesOptions}.
 */
export async function getUserServerStates(
	userId: string,
	opts: ServerStatesOptions = {},
): Promise<UserServerState[]> {
	const cfgs = Array.from(serverConfigs.values());

	// Which per-user servers this user has a usable credential for. Decrypt
	// once here (getMcpCredential logs on a rotated key) and reuse below, so a
	// rotated key warns once per server, not twice.
	const configured = new Set<string>();
	for (const cfg of cfgs) {
		if (cfg.auth === 'per_user' && getMcpCredential(userId, cfg.id) !== null) {
			configured.add(cfg.id);
		}
	}

	// Decide which configured servers to actually (re)connect on this call.
	// Disabled-for-this-conversation servers are skipped entirely; already-
	// `failed` servers are skipped when the caller circuit-breaks.
	const toConnect = [...configured].filter((id) => {
		if (opts.excludeCategories?.includes(`mcp:${id}`)) return false;
		if (opts.skipFailed && entries.get(keyFor(id, userId))?.state === 'failed') return false;
		return true;
	});

	// Of those, the ones the caller must actually WAIT for. A reaped connection
	// keeps its last tool list (see reapIfIdle) and `ensureConnected` carries it
	// into the reconnecting entry, so a server we've talked to before can report
	// its known surface immediately while the handshake runs in the background.
	//
	// This matters on the send path, where waiting is worse than it looks. The
	// budget bounds one turn, but idle reaping means a lightly-used server is
	// re-handshaked on the first turn after every reap — repeatedly, forever, at
	// the front of time-to-first-token. Shortening the budget instead would be
	// the wrong trade: a handshake that misses a tighter deadline drops that
	// server's tools from `tools[]` for the turn, and a tool surface that changes
	// because of *timing* is exactly the payload churn CLAUDE.md's prefix-cache
	// rule forbids (it re-prefills the whole conversation, and the model's
	// capabilities visibly blink). Not waiting keeps the surface stable AND
	// removes the stall; only a server with no known tools yet has anything to
	// wait for.
	const mustAwait = opts.connectBudgetMs != null ? toConnect.filter(hasNoKnownTools) : toConnect;
	const background =
		opts.connectBudgetMs != null ? toConnect.filter((id) => !hasNoKnownTools(id)) : [];

	function hasNoKnownTools(id: string): boolean {
		const e = entries.get(keyFor(id, userId));
		return !e || e.state === 'failed' || (e.tools?.length ?? 0) === 0;
	}

	// Fire-and-forget: these already have a usable surface to advertise.
	for (const id of background) void ensureConnected(id, userId).catch(() => {});

	// Connect them CONCURRENTLY (best-effort) before reading state — a user
	// with several per-user servers shouldn't pay the sum of their handshakes.
	// With a budget, a straggler resolves the wait early and finishes in the
	// background; without one, we await the full handshake (settings page).
	await Promise.all(
		mustAwait.map((id) =>
			opts.connectBudgetMs != null
				? withSoftDeadline(ensureConnected(id, userId), opts.connectBudgetMs)
				: ensureConnected(id, userId).catch(() => {}),
		),
	);

	const out: UserServerState[] = [];
	for (const cfg of cfgs) {
		const base = {
			id: cfg.id,
			displayName: cfg.displayName,
			transport: cfg.transport,
			auth: cfg.auth,
		};
		if (cfg.auth === 'global') {
			const e = entries.get(keyFor(cfg.id, null));
			out.push({
				...base,
				state: e?.state ?? 'idle',
				error: e?.state === 'failed' ? e.error : null,
				tools: e && e.state !== 'failed' ? (e.tools ?? []) : [],
				configured: true,
			});
			continue;
		}
		// per_user
		if (!configured.has(cfg.id)) {
			out.push({ ...base, state: 'needs-credential', error: null, tools: [], configured: false });
			continue;
		}
		const e = entries.get(keyFor(cfg.id, userId));
		out.push({
			...base,
			state: e?.state ?? 'failed',
			error: e?.state === 'failed' ? e.error : null,
			tools: e && e.state !== 'failed' ? (e.tools ?? []) : [],
			configured: true,
		});
	}
	return out;
}

/**
 * Per-call entry point used by MCP-bridge tools' execute(). For per-user
 * servers it resolves the caller's credential + connection; for global servers
 * `userId` is ignored. Retries exactly once on transport-send failures that
 * prove the request never reached the server (e.g. "Not connected", network
 * errors). Does NOT retry on protocol-level errors like timeouts,
 * connection-closed-after-send, or JSON-RPC errors — those may have executed
 * on the server and retrying could cause double-execution of side-effecting
 * tools.
 */
export async function callMcpTool(
	serverId: string,
	userId: string,
	toolName: string,
	args: unknown,
	signal: AbortSignal,
): Promise<McpCallResult> {
	const cfg = serverConfigs.get(serverId);
	if (!cfg) throw new Error(`mcp: unknown server "${serverId}"`);
	const effUserId = cfg.auth === 'per_user' ? userId : null;
	const key = keyFor(serverId, effUserId);
	const timeoutMs = cfg.timeoutSeconds * 1000;

	const conn = await ensureConnected(serverId, effUserId);
	try {
		const result = await conn.callTool(toolName, args, signal, timeoutMs);
		markActive(key);
		return result;
	} catch (err) {
		if (signal.aborted) throw err;

		// Only retry on transport-send failures that prove the request never
		// reached the server. Do NOT retry on protocol-level or server-side
		// errors where the request may have been processed:
		//   - McpError (timeout, connection-closed-after-send, JSON-RPC errors)
		//   - StreamableHTTPError (HTTP error status — server received the POST)
		// A missed retry on a genuine transport drop is recoverable (the model
		// re-calls); a double-execution of a side-effecting tool is not.
		if (err instanceof McpError || err instanceof StreamableHTTPError) {
			throw err;
		}

		markIdle(key);
		const conn2 = await ensureConnected(serverId, effUserId);
		const result = await conn2.callTool(toolName, args, signal, timeoutMs);
		markActive(key);
		return result;
	}
}

/**
 * Force a fresh connection attempt. For per-user servers, scoped to `userId`
 * (the requesting user's own connection); for global servers `userId` is
 * ignored. Drives the `/settings/mcp` retry button.
 */
export async function retryMcpServer(
	serverId: string,
	userId: string,
): Promise<{ state: 'connected' | 'failed'; error: string | null }> {
	const cfg = serverConfigs.get(serverId);
	if (!cfg) throw new Error(`mcp: unknown server "${serverId}"`);
	const effUserId = cfg.auth === 'per_user' ? userId : null;
	const key = keyFor(serverId, effUserId);

	const entry = entries.get(key);
	if (entry?.state === 'reconnecting') return summarizeSettled(await entry.promise);
	if (entry?.state === 'connected') {
		if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
		await entry.client.close().catch(() => {});
	}
	const eff = await getEffectiveCfg(serverId, effUserId);
	if (!eff) return { state: 'failed', error: 'No credential configured for this server' };
	const settled = await connectAndRecord(eff, serverId, effUserId, /* firstTime */ false);
	return summarizeSettled(settled);
}

/**
 * Drop a per-user connection (called after a user removes/replaces their
 * credential) so the next use reconnects with the new token instead of a
 * stale one. No-op when there's no live connection.
 */
export async function dropUserConnection(serverId: string, userId: string): Promise<void> {
	const key = keyFor(serverId, userId);
	const entry = entries.get(key);
	if (!entry) return;
	entries.delete(key);
	if (entry.state === 'connected') {
		if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
		await entry.client.close().catch(() => {});
	} else if (entry.state === 'reconnecting') {
		const settled = await entry.promise.catch(() => null);
		if (settled?.state === 'connected') await settled.client.close().catch(() => {});
	}
}

function summarizeSettled(e: Entry): { state: 'connected' | 'failed'; error: string | null } {
	return e.state === 'connected'
		? { state: 'connected', error: null }
		: e.state === 'failed'
			? { state: 'failed', error: e.error }
			: { state: 'failed', error: 'not connected' };
}

/** Resolve a server's connection-ready config for a given user: global servers
 *  use the boot-resolved key as-is; per-user servers get the user's decrypted
 *  token spliced in as `apiKey`. Null when a per-user credential is missing. */
async function getEffectiveCfg(
	serverId: string,
	userId: string | null,
): Promise<LoadedMcpServer | null> {
	const cfg = serverConfigs.get(serverId);
	if (!cfg) return null;
	if (cfg.auth === 'global' || userId === null) return cfg;
	if (cfg.transport !== 'http') return null; // per_user is HTTP-only (config-validated)
	const token = getMcpCredential(userId, serverId);
	if (!token) return null;
	return { ...cfg, apiKey: token };
}

async function ensureConnected(serverId: string, userId: string | null): Promise<McpConnection> {
	const key = keyFor(serverId, userId);
	const entry = entries.get(key);

	if (entry) {
		if (entry.state === 'connected') return entry.client;
		if (entry.state === 'reconnecting') {
			const settled = await entry.promise;
			if (settled.state === 'failed') {
				throw new Error(`mcp: server "${serverId}" failed to connect: ${settled.error}`);
			}
			if (settled.state !== 'connected') throw new Error(`mcp: server "${serverId}" not connected`);
			return settled.client;
		}
		// failed (boot-time, retry on demand) or idle (reaped / dropped).
		const existingTools = entry.state === 'idle' ? entry.tools : null;
		const settled = await connectAndRecord(entry.cfg, serverId, userId, false, existingTools);
		if (settled.state !== 'connected') {
			throw new Error(
				`mcp: reconnect for "${serverId}" failed: ${settled.state === 'failed' ? settled.error : 'unknown'}`,
			);
		}
		return settled.client;
	}

	// No entry yet — first use of a per-user (or lazily-connected) server.
	const eff = await getEffectiveCfg(serverId, userId);
	if (!eff) throw new Error(`mcp: no credential configured for server "${serverId}"`);
	const settled = await connectAndRecord(eff, serverId, userId, /* firstTime */ true);
	if (settled.state !== 'connected') {
		throw new Error(
			`mcp: server "${serverId}" failed to connect: ${settled.state === 'failed' ? settled.error : 'unknown'}`,
		);
	}
	return settled.client;
}

async function connectAndRecord(
	cfg: LoadedMcpServer,
	serverId: string,
	userId: string | null,
	firstTime: boolean,
	existingTools: McpToolDescriptor[] | null = null,
): Promise<Entry> {
	const key = keyFor(serverId, userId);
	// Coalesce concurrent attempts: install a reconnecting entry whose promise
	// every concurrent caller awaits.
	const reconnecting: Entry = {
		serverId,
		userId,
		state: 'reconnecting',
		cfg,
		tools: existingTools,
		promise: doConnect(cfg, serverId, userId, firstTime, existingTools),
	};
	entries.set(key, reconnecting);
	const settled = await reconnecting.promise;
	// Only replace if the current entry is still this reconnecting instance —
	// guards against races with a concurrent reaper / drop / shutdown.
	if (entries.get(key) === reconnecting) {
		entries.set(key, settled);
		if (settled.state === 'connected') scheduleIdleReap(key);
	}
	return settled;
}

async function doConnect(
	cfg: LoadedMcpServer,
	serverId: string,
	userId: string | null,
	firstTime: boolean,
	existingTools: McpToolDescriptor[] | null,
): Promise<Entry> {
	const key = keyFor(serverId, userId);
	const timeoutMs = cfg.timeoutSeconds * 1000;
	try {
		const client = await connectMcpServer(cfg, timeoutMs);
		const tools =
			firstTime || existingTools === null
				? await withTimeout(client.listTools(), timeoutMs, `${serverId} listTools`)
				: existingTools;
		client.onClose(() => markIdle(key));
		return {
			serverId,
			userId,
			state: 'connected',
			cfg,
			client,
			tools,
			lastUsedAt: Date.now(),
			idleTimerId: null,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (firstTime && userId === null) {
			console.warn(`[mcp] failed to connect to "${serverId}": ${msg}`);
		}
		return { serverId, userId, state: 'failed', cfg, error: msg };
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

/** Whether a connection should be idle-reaped: stdio (expensive subprocess)
 *  OR any per-user connection (we don't want N users × M servers of live HTTP
 *  sessions lingering). Global HTTP keeps no expensive state, so it isn't
 *  reaped. */
function reapable(entry: ConnectedState & { userId: string | null }): boolean {
	return entry.cfg.transport === 'stdio' || entry.userId !== null;
}

function scheduleIdleReap(key: string): void {
	const entry = entries.get(key);
	if (!entry || entry.state !== 'connected') return;
	if (!reapable(entry)) return;
	if (entry.cfg.idleTimeoutSeconds <= 0) return;
	if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
	const ms = entry.cfg.idleTimeoutSeconds * 1000;
	entry.idleTimerId = setTimeout(() => reapIfIdle(key), ms);
	if (typeof entry.idleTimerId === 'object' && entry.idleTimerId && 'unref' in entry.idleTimerId) {
		(entry.idleTimerId as { unref: () => void }).unref();
	}
}

function reapIfIdle(key: string): void {
	const entry = entries.get(key);
	if (!entry || entry.state !== 'connected') return;
	const idleMs = entry.cfg.idleTimeoutSeconds * 1000;
	const elapsed = Date.now() - entry.lastUsedAt;
	if (elapsed < idleMs) {
		entry.idleTimerId = null;
		scheduleIdleReap(key);
		return;
	}
	entries.set(key, {
		serverId: entry.serverId,
		userId: entry.userId,
		state: 'idle',
		cfg: entry.cfg,
		tools: entry.tools,
	});
	entry.client.close().catch(() => {});
}

function markActive(key: string): void {
	const entry = entries.get(key);
	if (entry?.state === 'connected') {
		entry.lastUsedAt = Date.now();
		scheduleIdleReap(key);
	}
}

function markIdle(key: string): void {
	const entry = entries.get(key);
	if (!entry) return;
	if (entry.state === 'connected') {
		if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
		entries.set(key, {
			serverId: entry.serverId,
			userId: entry.userId,
			state: 'idle',
			cfg: entry.cfg,
			tools: entry.tools,
		});
		entry.client.close().catch(() => {});
	}
}

/**
 * Close all live MCP connections — called by the sveltekit:shutdown hook
 * so teardown runs after in-flight requests settle.
 */
export async function stopMcp(): Promise<void> {
	await Promise.all(
		Array.from(entries.values()).map(async (e) => {
			if (e.state === 'connected') await e.client.close().catch(() => {});
		}),
	);
}

/**
 * Force the idle reap for one connection, as the idle timer eventually would.
 * Test-only — the real path is time-gated on `idle_timeout_seconds` (900s by
 * default), which a test can't wait out. Leaves the entry `idle` with its last
 * tool list intact, which is the state the send path relies on to advertise a
 * stable surface while reconnecting in the background.
 */
export async function reapUserConnectionForTests(
	serverId: string,
	userId: string | null,
): Promise<void> {
	const key = keyFor(serverId, userId);
	const entry = entries.get(key);
	if (!entry || entry.state !== 'connected') return;
	if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
	entries.set(key, {
		serverId: entry.serverId,
		userId: entry.userId,
		state: 'idle',
		cfg: entry.cfg,
		tools: entry.tools,
	});
	await entry.client.close().catch(() => {});
}

/**
 * Reset all in-process MCP state. Test-only. Closes any live connections,
 * clears every entry + the catalog, resets the one-shot init guard.
 */
export async function resetMcpRegistryForTests(): Promise<void> {
	for (const e of entries.values()) {
		if (e.state === 'connected') {
			if (e.idleTimerId) clearTimeout(e.idleTimerId);
			await e.client.close().catch(() => {});
		}
	}
	entries.clear();
	serverConfigs.clear();
	initPromise = null;
}
