/**
 * Per-conversation Pyodide worker pool.
 *
 * State machine mirrors `src/lib/server/mcp/registry.ts`:
 *   ready | starting | idle | failed
 * with `starting` playing the same promise-coalescing role as MCP's
 * `reconnecting`. The key difference is the per-worker mutex: Pyodide
 * runs a single Python interpreter per worker, so two concurrent
 * `runPython` calls to the same conversation MUST serialize. Without
 * the mutex the second call would either race the first (state
 * corruption) or simply fail at the WASM-bridge level.
 *
 * Workers are spawned lazily on first call per conversation, idle-reaped
 * after `idleTimeoutSeconds`, LRU-evicted when the pool fills past
 * `poolMax`, terminated on per-call wall-clock overrun, and reaped on
 * SIGINT/SIGTERM. The lifecycle is decoupled from the message loop
 * inside `worker.ts` — the pool only sees the `Worker` handle and the
 * shape of the messages.
 *
 * Stage 3 ships the pool with a mockable Worker factory so unit tests
 * cover the state machine without spinning up real Pyodide (which is
 * ~2-5 s of cold start and far too slow for the unit pass). Stage 4
 * wires `run_python` to the public API surface here.
 */

import { Worker as NodeWorker } from 'node:worker_threads';
import { getCodeInterpreterConfig } from './config';
import { listForbiddenHosts } from '../tools/url-policy';

// ---------------------------------------------------------------------------
// Worker factory — abstracted so tests can swap in a fake.
// ---------------------------------------------------------------------------

/**
 * Minimum surface area the pool requires from a worker handle. The real
 * implementation is `worker_threads.Worker`; tests pass a stub that
 * implements the same shape.
 */
export interface ManagedWorker {
	postMessage(value: unknown): void;
	on(event: 'message', listener: (value: unknown) => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'exit', listener: (code: number) => void): void;
	terminate(): Promise<number>;
}

export interface WorkerFactoryArgs {
	memoryMb: number;
}
export type WorkerFactory = (args: WorkerFactoryArgs) => ManagedWorker;

// NOTE: the URL resolves to `./worker.js` so this works against the
// `pnpm build` SSR output (Vite emits the worker as a chunk in the
// adapter-node bundle). For `pnpm dev`, Node's `worker_threads` can't
// load `.ts` directly through Vite — a follow-up will either pre-compile
// the worker module separately or wrap it in a tiny `.js` shim that
// loads via tsx. Unit tests bypass this entirely via
// `setWorkerFactoryForTests`.
const defaultWorkerUrl = new URL('./worker.js', import.meta.url);

const defaultWorkerFactory: WorkerFactory = ({ memoryMb }) =>
	new NodeWorker(defaultWorkerUrl, {
		resourceLimits: { maxOldGenerationSizeMb: memoryMb },
	}) as unknown as ManagedWorker;

let workerFactory: WorkerFactory = defaultWorkerFactory;

/** Test-only: override the worker constructor. Unit tests inject a stub
 *  that records postMessage calls and fires fake responses. */
export function setWorkerFactoryForTests(factory: WorkerFactory | null): void {
	workerFactory = factory ?? defaultWorkerFactory;
}

// ---------------------------------------------------------------------------
// Mutex — single-slot serializer. A new `acquire` chains onto the previous
// release; callers await the returned `release` callback when done.
// ---------------------------------------------------------------------------

class Mutex {
	private tail: Promise<void> = Promise.resolve();
	async acquire(): Promise<() => void> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prev = this.tail;
		this.tail = next;
		await prev;
		return release;
	}
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

interface ReadyEntry {
	state: 'ready';
	conversationId: string;
	worker: ManagedWorker;
	mutex: Mutex;
	lastUsedAt: number;
	idleTimerId: ReturnType<typeof setTimeout> | null;
	pendingResolvers: Map<number, PendingResolver>;
}

interface IdleEntry {
	state: 'idle';
	conversationId: string;
}

interface FailedEntry {
	state: 'failed';
	conversationId: string;
	error: string;
}

interface StartingEntry {
	state: 'starting';
	conversationId: string;
	promise: Promise<ReadyEntry | FailedEntry>;
}

type Entry = ReadyEntry | IdleEntry | FailedEntry | StartingEntry;

interface PendingResolver {
	resolve: (value: WorkerRunResult) => void;
	reject: (err: Error) => void;
}

const entries = new Map<string, Entry>();
let nextCallId = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunPythonPreFile {
	filename: string;
	bytes: Uint8Array;
	sha256: string;
}

export interface RunPythonPostFile {
	filename: string;
	bytes: Uint8Array;
	sha256: string;
}

export interface RunPythonParams {
	conversationId: string;
	code: string;
	disabledFeatures: readonly string[];
	/** Files to materialize into the worker's `/workspace/` before
	 *  executing `code`. Per-worker manifest skips byte-identical
	 *  re-copies across calls. */
	preFiles?: readonly RunPythonPreFile[];
	/** Per-call wall-clock cap in ms; overrides the config default. */
	callTimeoutMs?: number;
	/** External abort signal (e.g. the streaming-relay turn signal). */
	ctxSignal?: AbortSignal;
	/** Status callback for the cold-start path; fires before/after
	 *  `loadPyodide` on a `starting` entry. Stage 4 uses this to bridge to
	 *  the `tool_call_executing.status` SSE event. */
	onStatus?: (status: string) => void;
}

export interface WorkerRunResult {
	stdout: string;
	stderr: string;
	result: unknown;
	/** Files written under `/workspace/` during this call that differ
	 *  from the pre-call snapshot (new + modified). The caller persists
	 *  them via MediaStore + insertMedia. */
	newFiles: RunPythonPostFile[];
}

/**
 * Execute Python in this conversation's worker. Per-conversation mutex
 * means parallel calls to the same conversation queue; calls to different
 * conversations execute concurrently against separate workers.
 *
 * On timeout: the worker is terminated, the entry is transitioned to
 * `failed`, and the next call spawns a fresh worker (variables gone —
 * the tool description tells the model this can happen).
 */
export async function runPython(params: RunPythonParams): Promise<WorkerRunResult> {
	const cfg = getCodeInterpreterConfig();
	const timeoutMs = params.callTimeoutMs ?? cfg.callTimeoutSeconds * 1000;

	// B5: re-validation + retry loop. After acquiring the mutex, check that
	// the entry is still the current one for this conversation and still in
	// 'ready' state. The mutex wait can be arbitrarily long (a concurrent
	// call in the same conversation runs to completion or times out), so
	// the entry may have been terminated (timeout), evicted (enforcePoolCap),
	// or reaped (reapIfIdle) while this call was queued. If stale, release
	// the stale mutex and retry with a fresh worker.
	//
	// Cap retries to avoid an infinite loop if ensureReady keeps failing
	// (e.g. the pool is saturated and every startWorker call either throws
	// or produces a FailedEntry).
	const MAX_RETRIES = 1;
	for (let attempt = 0; ; attempt++) {
		const entry = await ensureReady(params.conversationId, params.onStatus);
		const release = await entry.mutex.acquire();

		// Re-check that this entry is still valid after the (potentially
		// long) mutex wait.
		const current = entries.get(params.conversationId);
		if (current && current === entry && current.state === 'ready') {
			// Entry is still valid — proceed with the call.
			const callId = nextCallId++;
			try {
				return await new Promise<WorkerRunResult>((resolve, reject) => {
					let settled = false;
					const finish = (err: Error | null, value?: WorkerRunResult) => {
						if (settled) return;
						settled = true;
						clearTimeout(timeoutHandle);
						if (params.ctxSignal) params.ctxSignal.removeEventListener('abort', onAbort);
						entry.pendingResolvers.delete(callId);
						if (err) reject(err);
						else resolve(value!);
					};

					// Route the worker's reply for this callId through finish, so
					// timeout / abort / result paths all settle the outer Promise
					// through one chokepoint.
					entry.pendingResolvers.set(callId, {
						resolve: (v) => finish(null, v),
						reject: (e) => finish(e),
					});

					const onAbort = () => {
						// Settle the in-flight promise FIRST so the worker.terminate()
						// that follows (which can fire 'exit' synchronously) finds an
						// empty pendingResolvers map and doesn't double-reject with a
						// misleading "exited unexpectedly" error.
						finish(new Error('run_python: aborted by caller'));
						void terminateAndMarkFailed(entry, 'aborted by caller signal');
					};
					if (params.ctxSignal) {
						if (params.ctxSignal.aborted) {
							onAbort();
							return;
						}
						params.ctxSignal.addEventListener('abort', onAbort);
					}

					const timeoutHandle = setTimeout(() => {
						// Same ordering reason as onAbort: settle the promise with the
						// authoritative timeout error before terminating, so the
						// 'exit' handler can't race in and overwrite it with a less
						// informative "worker exited" rejection.
						finish(
							new Error(
								`run_python: exceeded ${Math.round(timeoutMs / 1000)}s wall-clock budget; interpreter restarted (variables lost)`,
							),
						);
						void terminateAndMarkFailed(
							entry,
							`run_python: exceeded ${Math.round(timeoutMs / 1000)}s wall-clock budget`,
						);
					}, timeoutMs);
					// Don't keep the event loop alive purely for an in-flight timeout.
					if (typeof timeoutHandle === 'object' && timeoutHandle && 'unref' in timeoutHandle) {
						(timeoutHandle as { unref: () => void }).unref();
					}

					entry.worker.postMessage({
						type: 'run',
						callId,
						code: params.code,
						disabledFeatures: [...params.disabledFeatures],
						preFiles: params.preFiles ? [...params.preFiles] : [],
					});
					entry.lastUsedAt = Date.now();
					scheduleIdleReap(params.conversationId);
				});
			} finally {
				release();
			}
		}

		// Stale entry: release the mutex we acquired from the dead/invalid
		// entry so other waiters can also detect staleness and retry.
		release();
		if (attempt >= MAX_RETRIES) {
			throw new Error(
				`code_interpreter: failed to acquire a stable worker after ${MAX_RETRIES + 1} attempts`,
			);
		}
		// Loop — ensureReady will create/spawn a fresh worker.
	}
}

export interface WorkerStateView {
	conversationId: string;
	state: Entry['state'];
	error?: string;
}

/** Snapshot of the pool — used by a future diagnostics surface. */
export function listWorkerStates(): WorkerStateView[] {
	return Array.from(entries.values()).map((e) => ({
		conversationId: e.conversationId,
		state: e.state,
		error: e.state === 'failed' ? e.error : undefined,
	}));
}

// ---------------------------------------------------------------------------
// Lifecycle internals
// ---------------------------------------------------------------------------

async function ensureReady(
	conversationId: string,
	onStatus?: (status: string) => void,
): Promise<ReadyEntry> {
	const existing = entries.get(conversationId);
	if (existing?.state === 'ready') return existing;
	if (existing?.state === 'starting') {
		const settled = await existing.promise;
		if (settled.state === 'ready') return settled;
		throw new Error(`code_interpreter: failed to start worker: ${settled.error}`);
	}
	// 'idle' or 'failed' or absent: try to (re)spawn. Concurrent callers
	// coalesce via a single `starting` entry.
	return startWorker(conversationId, onStatus);
}

async function startWorker(
	conversationId: string,
	onStatus?: (status: string) => void,
): Promise<ReadyEntry> {
	enforcePoolCap();

	const starting: StartingEntry = {
		state: 'starting',
		conversationId,
		promise: doStart(conversationId, onStatus),
	};
	entries.set(conversationId, starting);

	const settled = await starting.promise;
	if (entries.get(conversationId) === starting) {
		entries.set(conversationId, settled);
	}
	if (settled.state === 'failed') {
		throw new Error(`code_interpreter: failed to start worker: ${settled.error}`);
	}
	scheduleIdleReap(conversationId);
	return settled;
}

async function doStart(
	conversationId: string,
	onStatus?: (status: string) => void,
): Promise<ReadyEntry | FailedEntry> {
	const cfg = getCodeInterpreterConfig();
	try {
		onStatus?.('Starting Python interpreter…');
		const worker = workerFactory({ memoryMb: cfg.workerMemoryMb });
		const pendingResolvers = new Map<number, PendingResolver>();

		// Wire the message → resolver routing once per worker.
		worker.on('message', (raw: unknown) => {
			if (!raw || typeof raw !== 'object') return;
			const msg = raw as {
				type?: string;
				callId?: number;
				stdout?: string;
				stderr?: string;
				result?: unknown;
				message?: string;
				newFiles?: RunPythonPostFile[];
			};
			if (msg.type === 'result' && typeof msg.callId === 'number') {
				const resolver = pendingResolvers.get(msg.callId);
				resolver?.resolve({
					stdout: msg.stdout ?? '',
					stderr: msg.stderr ?? '',
					result: msg.result ?? null,
					newFiles: msg.newFiles ?? [],
				});
			} else if (msg.type === 'error' && typeof msg.callId === 'number') {
				const resolver = pendingResolvers.get(msg.callId);
				resolver?.reject(new Error(msg.message ?? 'run_python: unknown worker error'));
			}
		});

		worker.on('error', (err: Error) => {
			markFailed(conversationId, err.message);
		});

		worker.on('exit', (code: number) => {
			// Non-zero exit (OOM, terminate(), crash). Any in-flight call
			// gets a clean rejection so the caller sees an actionable error
			// rather than hanging forever.
			const isError = code !== 0;
			for (const resolver of pendingResolvers.values()) {
				resolver.reject(
					new Error(
						isError
							? `run_python: worker exited with code ${code} (likely OOM or terminated due to timeout — interpreter restarted, variables lost)`
							: 'run_python: worker exited unexpectedly',
					),
				);
			}
			pendingResolvers.clear();
			const entry = entries.get(conversationId);
			if (entry?.state === 'ready' && entry.worker === worker) {
				markFailed(conversationId, `worker exited with code ${code}`);
			}
		});

		// Init the Pyodide instance inside the worker. The promise resolves
		// when the worker confirms it's ready.
		await new Promise<void>((resolve, reject) => {
			const onReady = (raw: unknown) => {
				if (!raw || typeof raw !== 'object') return;
				const m = raw as { type?: string; message?: string };
				if (m.type === 'ready') {
					resolve();
				} else if (m.type === 'error') {
					reject(new Error(m.message ?? 'Pyodide failed to initialize'));
				}
			};
			worker.on('message', onReady);
			worker.postMessage({
				type: 'init',
				indexURL: cfg.pyodideIndexUrl || undefined,
				// Snapshot the configured-backend host list and ship it
				// across the message channel. The worker is bundled
				// standalone and has no access to SvelteKit's env / config
				// layer, so we apply the same policy by handing it the
				// resolved set up front.
				forbiddenHosts: listForbiddenHosts(),
			});
		});
		onStatus?.('Python interpreter ready');

		const ready: ReadyEntry = {
			state: 'ready',
			conversationId,
			worker,
			mutex: new Mutex(),
			lastUsedAt: Date.now(),
			idleTimerId: null,
			pendingResolvers,
		};
		return ready;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { state: 'failed', conversationId, error: msg };
	}
}

function enforcePoolCap(): void {
	const cap = getCodeInterpreterConfig().poolMax;
	const liveEntries = Array.from(entries.values()).filter(
		(e) => e.state === 'ready' || e.state === 'starting',
	);
	if (liveEntries.length < cap) return;

	// LRU-evict a ready entry whose mutex isn't currently held. Skip
	// starting entries (someone's actively waiting on them). If every
	// slot is in-flight, the caller eats a clear error rather than
	// silently queueing.
	const ready = liveEntries.filter((e): e is ReadyEntry => e.state === 'ready');

	// Only consider truly idle workers — those with no in-flight calls.
	const idle = ready.filter((e) => e.pendingResolvers.size === 0);
	if (idle.length > 0) {
		// Sort by lastUsedAt ascending so the oldest is first.
		idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
		const victim = idle[0];
		if (victim.idleTimerId) clearTimeout(victim.idleTimerId);
		void victim.worker.terminate().catch(() => {});
		entries.delete(victim.conversationId);
		return;
	}

	// All ready entries are busy — or every slot is still starting up.
	if (ready.length > 0) {
		throw new Error(
			`code_interpreter: pool at capacity (${cap}); all workers are busy. Try again momentarily.`,
		);
	}
	throw new Error(
		`code_interpreter: pool at capacity (${cap}); all workers are starting up. Try again momentarily.`,
	);
}

function scheduleIdleReap(conversationId: string): void {
	const cfg = getCodeInterpreterConfig();
	if (cfg.idleTimeoutSeconds <= 0) return;
	const entry = entries.get(conversationId);
	if (!entry || entry.state !== 'ready') return;
	if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
	const ms = cfg.idleTimeoutSeconds * 1000;
	entry.idleTimerId = setTimeout(() => reapIfIdle(conversationId), ms);
	if (typeof entry.idleTimerId === 'object' && entry.idleTimerId && 'unref' in entry.idleTimerId) {
		(entry.idleTimerId as { unref: () => void }).unref();
	}
}

function reapIfIdle(conversationId: string): void {
	const entry = entries.get(conversationId);
	if (!entry || entry.state !== 'ready') return;

	// Don't terminate a worker with a call still in flight.
	if (entry.pendingResolvers.size > 0) {
		entry.idleTimerId = null;
		scheduleIdleReap(conversationId);
		return;
	}

	const idleMs = getCodeInterpreterConfig().idleTimeoutSeconds * 1000;
	const elapsed = Date.now() - entry.lastUsedAt;
	if (elapsed < idleMs) {
		// A call landed between schedule and fire. Reschedule.
		entry.idleTimerId = null;
		scheduleIdleReap(conversationId);
		return;
	}
	entries.set(conversationId, { state: 'idle', conversationId });
	void entry.worker.terminate().catch(() => {});
}

async function terminateAndMarkFailed(entry: ReadyEntry, reason: string): Promise<void> {
	if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
	if (entries.get(entry.conversationId) === entry) {
		entries.set(entry.conversationId, {
			state: 'failed',
			conversationId: entry.conversationId,
			error: reason,
		});
	}
	try {
		await entry.worker.terminate();
	} catch {
		// terminate is best-effort; the worker may already be gone.
	}
}

function markFailed(conversationId: string, error: string): void {
	const entry = entries.get(conversationId);
	if (!entry) return;
	if (entry.state === 'ready') {
		if (entry.idleTimerId) clearTimeout(entry.idleTimerId);
	}
	entries.set(conversationId, { state: 'failed', conversationId, error });
}

/**
 * Terminate all pool workers — called by the sveltekit:shutdown hook
 * so clean teardown runs after in-flight requests settle.
 */
export async function stopPool(): Promise<void> {
	await Promise.all(
		Array.from(entries.values()).map(async (e) => {
			if (e.state === 'ready') {
				await e.worker.terminate().catch(() => {});
			}
		}),
	);
}

/** Test-only: clear every entry, terminate live workers, reset state. */
export async function resetCodeInterpreterPoolForTests(): Promise<void> {
	for (const e of entries.values()) {
		if (e.state === 'ready') {
			if (e.idleTimerId) clearTimeout(e.idleTimerId);
			await e.worker.terminate().catch(() => {});
		}
	}
	entries.clear();
	nextCallId = 1;
}
