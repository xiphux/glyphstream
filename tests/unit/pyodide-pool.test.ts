/**
 * Unit tests for the Pyodide worker pool — state machine + mutex + idle
 * reaper + timeout + LRU eviction. Uses a `MockWorker` that records
 * `postMessage` calls and lets the test drive replies on the message
 * channel, so we exercise the pool's behavior without booting real
 * Pyodide (which is ~2-5 s of cold start).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock the config module so the pool's getCodeInterpreterConfig returns
// test-tuned values without hitting the disk-backed config loader. The
// real config layer is exercised in code-interpreter-config.test.ts;
// here we just need fast access to a stable object. Using vi.hoisted
// guarantees the testConfig object is defined before the vi.mock factory
// runs (vi.mock is hoisted to module-top, ahead of plain `const`).
const mocks = vi.hoisted(() => ({
	testConfig: {
		enabled: true,
		poolMax: 3,
		idleTimeoutSeconds: 60,
		callTimeoutSeconds: 2,
		workerMemoryMb: 64,
		pyodideIndexUrl: '',
	},
}));
const testConfig = mocks.testConfig;
vi.mock('$lib/server/code-interpreter/config', () => ({
	getCodeInterpreterConfig: () => mocks.testConfig,
	isCodeInterpreterEnabled: () => mocks.testConfig.enabled,
	resetCodeInterpreterConfigForTests: () => {},
}));

import {
	type ManagedWorker,
	resetCodeInterpreterPoolForTests,
	runPython,
	setWorkerFactoryForTests,
} from '$lib/server/code-interpreter/pool';

// ---------------------------------------------------------------------------
// Test harness — a MockWorker that fans worker_threads events through an
// EventEmitter and exposes hooks for tests to drive replies.
// ---------------------------------------------------------------------------

class MockWorker extends EventEmitter implements ManagedWorker {
	posts: unknown[] = [];
	terminated = false;
	/** Set by the test to control how each `run` message is answered. */
	onRun?: (msg: { callId: number; code: string; disabledFeatures: string[] }) => void;
	/** Set by the test to delay the `ready` reply during init. */
	readyDelayMs = 0;

	postMessage(value: unknown): void {
		this.posts.push(value);
		const msg = value as {
			type: string;
			callId?: number;
			code?: string;
			disabledFeatures?: string[];
		};
		if (msg.type === 'init') {
			const ack = () => this.emit('message', { type: 'ready' });
			if (this.readyDelayMs > 0) setTimeout(ack, this.readyDelayMs);
			else queueMicrotask(ack);
		} else if (msg.type === 'run' && this.onRun) {
			this.onRun(msg as { callId: number; code: string; disabledFeatures: string[] });
		}
	}

	async terminate(): Promise<number> {
		this.terminated = true;
		this.emit('exit', 0);
		return 0;
	}
}

let createdWorkers: MockWorker[] = [];

beforeEach(() => {
	// Defaults restored each test in case a prior one mutated them.
	testConfig.enabled = true;
	testConfig.poolMax = 3;
	testConfig.idleTimeoutSeconds = 60;
	testConfig.callTimeoutSeconds = 2;
	testConfig.workerMemoryMb = 64;
	testConfig.pyodideIndexUrl = '';

	createdWorkers = [];
	setWorkerFactoryForTests(() => {
		const w = new MockWorker();
		createdWorkers.push(w);
		return w;
	});
});

afterEach(async () => {
	await resetCodeInterpreterPoolForTests();
	setWorkerFactoryForTests(null);
	vi.useRealTimers();
});

// Helper: drive a successful run reply from the latest worker for a
// given callId. Posts the result message back through the worker's
// emitter so the pool's resolver fires.
function replyOk(worker: MockWorker, callId: number, result: unknown = null): void {
	worker.emit('message', {
		type: 'result',
		callId,
		stdout: '',
		stderr: '',
		result,
	});
}

describe('runPython — happy path + isolation', () => {
	it('routes a single call: spawns one worker, posts init+run, resolves with the result', async () => {
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = ({ callId }) => replyOk(w, callId, { x: 42 });
			createdWorkers.push(w);
			return w;
		});

		const result = await runPython({
			conversationId: 'c1',
			code: 'x = 42',
			disabledFeatures: [],
		});

		expect(result.result).toEqual({ x: 42 });
		expect(createdWorkers).toHaveLength(1);
		const worker = createdWorkers[0];
		// The init message also carries the configured-backend host set
		// (from `listForbiddenHosts`), which varies by config.toml.
		// Match the shape but not the host list — that's covered in
		// url-policy.test.ts.
		expect(worker.posts[0]).toMatchObject({ type: 'init' });
		expect(worker.posts[1]).toMatchObject({
			type: 'run',
			code: 'x = 42',
			disabledFeatures: [],
		});
	});

	it('reuses the same worker across calls in the same conversation', async () => {
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = ({ callId }) => replyOk(w, callId);
			createdWorkers.push(w);
			return w;
		});

		await runPython({ conversationId: 'same', code: '1+1', disabledFeatures: [] });
		await runPython({ conversationId: 'same', code: '2+2', disabledFeatures: [] });
		await runPython({ conversationId: 'same', code: '3+3', disabledFeatures: [] });

		// Exactly one MockWorker should have been constructed.
		expect(createdWorkers).toHaveLength(1);
	});

	it('spawns a separate worker per conversation', async () => {
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = ({ callId }) => replyOk(w, callId);
			createdWorkers.push(w);
			return w;
		});

		await Promise.all([
			runPython({ conversationId: 'a', code: '1', disabledFeatures: [] }),
			runPython({ conversationId: 'b', code: '2', disabledFeatures: [] }),
		]);

		expect(createdWorkers).toHaveLength(2);
	});
});

describe('mutex — serializes concurrent calls in the same conversation', () => {
	it('only dispatches one run to the worker at a time; the rest queue behind the mutex', async () => {
		// Parked-reply mode: onRun records the callId but never replies.
		// We then watch dispatchedRuns to see exactly which messages have
		// been forwarded to the worker — only one at a time should appear
		// while the in-flight call is unresolved.
		//
		// Note on ordering: with two parallel runPython() calls to the
		// same conversation, the async chain doesn't guarantee which one
		// acquires the mutex first (both await ensureReady through
		// different hop counts), so the test treats the dispatch order
		// as opaque and only asserts the serialization invariant.
		const dispatchedRuns: number[] = [];
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = ({ callId }) => {
				dispatchedRuns.push(callId);
				// Park — no reply until the test replies for it.
			};
			createdWorkers.push(w);
			return w;
		});

		// Track which runPython resolved with which value via .then so
		// the test can release them in dispatch order regardless of
		// async ordering.
		const settled: Array<{ tag: string; value?: unknown; error?: string }> = [];
		void runPython({
			conversationId: 'c',
			code: 'first',
			disabledFeatures: [],
			callTimeoutMs: 30_000,
		}).then(
			(v) => settled.push({ tag: 'first', value: v.result }),
			(e) => settled.push({ tag: 'first', error: e.message }),
		);
		void runPython({
			conversationId: 'c',
			code: 'second',
			disabledFeatures: [],
			callTimeoutMs: 30_000,
		}).then(
			(v) => settled.push({ tag: 'second', value: v.result }),
			(e) => settled.push({ tag: 'second', error: e.message }),
		);

		// Let the worker boot + the first call dispatch.
		await new Promise((r) => setTimeout(r, 30));
		// Serialization: only ONE run message should have been sent to
		// the worker even though both runPython calls are outstanding.
		expect(dispatchedRuns).toHaveLength(1);

		const w = createdWorkers[0];
		const firstCallId = dispatchedRuns[0];
		replyOk(w, firstCallId, 'reply-1');

		// After the first call resolves, the second should dispatch.
		await new Promise((r) => setTimeout(r, 30));
		expect(dispatchedRuns).toHaveLength(2);
		expect(dispatchedRuns[1]).not.toBe(firstCallId);
		// And exactly one of the two runPython calls should now be
		// settled with the first reply.
		expect(settled).toHaveLength(1);
		expect(settled[0].value).toBe('reply-1');

		// Release the second call so the test can exit cleanly.
		replyOk(w, dispatchedRuns[1], 'reply-2');
		await new Promise((r) => setTimeout(r, 30));
		expect(settled).toHaveLength(2);
		expect(settled[1].value).toBe('reply-2');
	});
});

describe('starting-state coalescing', () => {
	it('two concurrent calls to a new conversation share one init', async () => {
		// Slow the init reply so the second caller arrives while the first
		// is still in `starting`. Both should await the same promise and
		// the pool should construct only one Worker.
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.readyDelayMs = 30;
			w.onRun = ({ callId }) => replyOk(w, callId);
			createdWorkers.push(w);
			return w;
		});

		await Promise.all([
			runPython({ conversationId: 'coalesce', code: '1', disabledFeatures: [] }),
			runPython({ conversationId: 'coalesce', code: '2', disabledFeatures: [] }),
		]);

		expect(createdWorkers).toHaveLength(1);
	});
});

describe('timeout — terminate and transition to failed', () => {
	it('aborts a call that exceeds the wall-clock budget; subsequent calls spawn fresh', async () => {
		vi.useFakeTimers();

		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			// Never reply — simulates a stuck Python interpreter.
			w.onRun = () => {};
			createdWorkers.push(w);
			return w;
		});

		const p = runPython({
			conversationId: 'stuck',
			code: 'while True: pass',
			disabledFeatures: [],
			callTimeoutMs: 50,
		});
		// Capture the rejection early so it isn't surfaced as an unhandled
		// rejection while fake-timer ticks are draining microtasks — the
		// actual assertion happens below against `outcome`.
		const outcome = p.then(
			() => ({ ok: true as const }),
			(e: Error) => ({ ok: false as const, message: e.message }),
		);

		// Drive the init's microtask ack first, then advance past the
		// per-call timeout.
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(60);

		const result = await outcome;
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.message).toMatch(/wall-clock budget/);
		expect(createdWorkers[0].terminated).toBe(true);

		// Now drive the timers out for the rest of the test and let real
		// timers handle the new spawn.
		vi.useRealTimers();

		// A second call to the same conversation should spawn a NEW
		// worker (the first is dead), and complete normally.
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = ({ callId }) => replyOk(w, callId);
			createdWorkers.push(w);
			return w;
		});

		await expect(
			runPython({
				conversationId: 'stuck',
				code: '1',
				disabledFeatures: [],
			}),
		).resolves.toBeDefined();
		expect(createdWorkers.length).toBeGreaterThan(1);
	});
});

describe('idle reaper', () => {
	it('terminates a worker after the configured idle window of inactivity', async () => {
		vi.useFakeTimers();

		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = ({ callId }) => replyOk(w, callId);
			createdWorkers.push(w);
			return w;
		});

		const p = runPython({
			conversationId: 'idle',
			code: '1',
			disabledFeatures: [],
		});
		await vi.advanceTimersByTimeAsync(1);
		await p;

		// Config says 60 s idle. Just past it the worker should be reaped.
		expect(createdWorkers[0].terminated).toBe(false);
		await vi.advanceTimersByTimeAsync(61_000);
		expect(createdWorkers[0].terminated).toBe(true);

		vi.useRealTimers();
	});
});

describe('LRU eviction', () => {
	it('terminates the oldest ready worker when the pool would exceed pool_max', async () => {
		// pool_max = 3 (from beforeEach config). Spin up 3 conversations,
		// then make a 4th — the oldest should be evicted.
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = ({ callId }) => replyOk(w, callId);
			createdWorkers.push(w);
			return w;
		});

		await runPython({ conversationId: 'a', code: '1', disabledFeatures: [] });
		await new Promise((r) => setTimeout(r, 1));
		await runPython({ conversationId: 'b', code: '2', disabledFeatures: [] });
		await new Promise((r) => setTimeout(r, 1));
		await runPython({ conversationId: 'c', code: '3', disabledFeatures: [] });
		await new Promise((r) => setTimeout(r, 1));
		expect(createdWorkers).toHaveLength(3);
		expect(createdWorkers.every((w) => !w.terminated)).toBe(true);

		// Fourth call — 'a' was the oldest, should be the evicted one.
		await runPython({ conversationId: 'd', code: '4', disabledFeatures: [] });
		expect(createdWorkers).toHaveLength(4);
		expect(createdWorkers[0].terminated).toBe(true); // 'a' evicted
		expect(createdWorkers[1].terminated).toBe(false);
		expect(createdWorkers[2].terminated).toBe(false);
		expect(createdWorkers[3].terminated).toBe(false);
	});

	it('does not terminate a busy worker when enforcing the pool cap', async () => {
		// pool_max = 3 (from beforeEach). Seed the pool with 3 conversations,
		// one of which has a call still in flight (parked — never replies).
		// When a 4th conversation starts, enforcePoolCap should skip the
		// busy worker and evict one of the idle ones instead.
		let parkedCallId: number | undefined;
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = (msg) => {
				if (msg.code === 'park') {
					// Record the callId but never reply — stays in flight.
					parkedCallId = msg.callId;
				} else {
					replyOk(w, msg.callId);
				}
			};
			createdWorkers.push(w);
			return w;
		});

		// 'a' runs and completes (idle).
		await runPython({ conversationId: 'a', code: 'a', disabledFeatures: [] });
		await new Promise((r) => setTimeout(r, 1));
		// 'b' runs with 'park' — this call never resolves. Swallow the
		// eventual rejection so afterEach cleanup (worker termination)
		// doesn't surface as an unhandled rejection.
		const inFlightB = runPython({ conversationId: 'b', code: 'park', disabledFeatures: [] }).catch(
			() => {},
		);
		await new Promise((r) => setTimeout(r, 10));
		// 'c' runs and completes (idle).
		await runPython({ conversationId: 'c', code: 'c', disabledFeatures: [] });
		await new Promise((r) => setTimeout(r, 1));

		expect(createdWorkers).toHaveLength(3);
		expect(createdWorkers.every((w) => !w.terminated)).toBe(true);

		// Fourth call — 'a' is the oldest idle worker and should be evicted.
		// 'b' is busy (parked call) and must NOT be terminated.
		await runPython({ conversationId: 'd', code: 'd', disabledFeatures: [] });
		expect(createdWorkers).toHaveLength(4);
		expect(createdWorkers[0].terminated).toBe(true); // 'a' (oldest idle) evicted
		expect(createdWorkers[1].terminated).toBe(false); // 'b' (busy) preserved
		expect(createdWorkers[2].terminated).toBe(false);
		expect(createdWorkers[3].terminated).toBe(false);
	});

	it('throws "pool at capacity — all busy" when every ready worker has a call in flight', async () => {
		// pool_max = 2 — override from the default 3 so we can saturate
		// with fewer park-mode workers.
		testConfig.poolMax = 2;
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = () => {}; // Park — never reply
			createdWorkers.push(w);
			return w;
		});

		// Start two in-flight calls that never complete. Swallow their
		// eventual rejections so afterEach cleanup doesn't surface as
		// unhandled rejections.
		const inFlightA = runPython({ conversationId: 'a', code: 'hang', disabledFeatures: [] }).catch(
			() => {},
		);
		const inFlightB = runPython({ conversationId: 'b', code: 'hang', disabledFeatures: [] }).catch(
			() => {},
		);

		// Wait for both workers to boot and reach 'ready' with pending resolvers.
		await new Promise((r) => setTimeout(r, 30));

		expect(createdWorkers).toHaveLength(2);
		expect(createdWorkers[0].terminated).toBe(false);
		expect(createdWorkers[1].terminated).toBe(false);

		// Third call — pool at capacity, all workers busy — should throw.
		await expect(
			runPython({ conversationId: 'c', code: 'overflow', disabledFeatures: [] }),
		).rejects.toThrow(/pool at capacity.*busy/);

		// Assert neither busy worker was terminated.
		expect(createdWorkers[0].terminated).toBe(false);
		expect(createdWorkers[1].terminated).toBe(false);
	});
});

describe('worker exit propagation', () => {
	it('rejects in-flight calls with a memory-cap-style error when the worker exits non-zero', async () => {
		setWorkerFactoryForTests(() => {
			const w: MockWorker = new MockWorker();
			// Don't reply; instead simulate an OOM exit while the call is
			// in flight.
			w.onRun = () => {
				queueMicrotask(() => w.emit('exit', 134)); // 134 ≈ SIGABRT (OOM-like)
			};
			createdWorkers.push(w);
			return w;
		});

		await expect(
			runPython({ conversationId: 'oom', code: '[]*999', disabledFeatures: [] }),
		).rejects.toThrow(/worker exited with code 134/);
		// We didn't call .terminate(); the worker self-exited.
		expect(createdWorkers[0].terminated).toBe(false);
	});
});

describe('ctxSignal — abort terminates the worker', () => {
	it('rejects on an externally-aborted signal and tears down the worker', async () => {
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = () => {}; // hang
			createdWorkers.push(w);
			return w;
		});

		const ctrl = new AbortController();
		const p = runPython({
			conversationId: 'abort',
			code: 'stuck',
			disabledFeatures: [],
			ctxSignal: ctrl.signal,
		});

		// Let init complete, then abort.
		await new Promise((r) => setTimeout(r, 10));
		ctrl.abort();
		await expect(p).rejects.toThrow(/aborted/);
		expect(createdWorkers[0].terminated).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// B5: stale-entry recovery — re-validation after mutex acquire
// ---------------------------------------------------------------------------

describe('stale entry recovery — B5', () => {
	it('synchronous exit in the executor rejects — minimal smoke test', async () => {
		setWorkerFactoryForTests(() => {
			const w = new MockWorker();
			w.onRun = () => {
				w.emit('exit', 1); // synchronous exit during postMessage
			};
			createdWorkers.push(w);
			return w;
		});

		await expect(
			runPython({ conversationId: 'smoke', code: 'x', disabledFeatures: [] }),
		).rejects.toThrow(/worker exited/);
	});

	it('recovers when a concurrent worker crashes while another call waits on the mutex', async () => {
		// Two concurrent calls for the same conversation.
		// Call A's worker exits (crash) while Call B is queued on the mutex.
		// Without the B5 fix, B would acquire the stale mutex, postMessage
		// to the terminated worker (a silent no-op), and hang until timeout.
		// With the fix, B detects the entry is no longer current, releases
		// the stale mutex, retries ensureReady which spawns a fresh worker,
		// and completes normally.
		//
		// Note: async scheduling means either call may acquire the mutex
		// first — the test only asserts ONE rejects (worker exit) and the
		// OTHER fulfills (recovered on fresh worker), without assuming order.

		let workerIdx = 0;
		setWorkerFactoryForTests(() => {
			const idx = workerIdx++;
			const w = new MockWorker();
			if (idx === 0) {
				// First worker: simulate crash synchronously during run dispatch,
				// so the exit handler fires within the Promise executor where the
				// resolver is already registered.
				w.onRun = () => {
					w.emit('exit', 1);
				};
			} else {
				// Subsequent workers (spawned on retry): reply immediately.
				w.onRun = ({ callId }) => replyOk(w, callId, { recovered: true });
			}
			createdWorkers.push(w);
			return w;
		});

		// Collect outcomes from both calls without assuming order.
		const outcomes: Array<{ ok: boolean; error?: string; value?: unknown }> = [];

		// Park both promises with .catch() to prevent unhandled rejections.
		const p1 = runPython({
			conversationId: 'c',
			code: 'a',
			disabledFeatures: [],
		}).then(
			(v) => outcomes.push({ ok: true, value: v.result }),
			(e: Error) => outcomes.push({ ok: false, error: e.message }),
		);

		const p2 = runPython({
			conversationId: 'c',
			code: 'b',
			disabledFeatures: [],
		}).then(
			(v) => outcomes.push({ ok: true, value: v.result }),
			(e: Error) => outcomes.push({ ok: false, error: e.message }),
		);

		await Promise.all([p1, p2]);

		expect(outcomes).toHaveLength(2);

		// One call must have been rejected with a worker-exit error,
		// NOT a timeout error (would indicate the B5 fix is missing).
		const crashed = outcomes.find((o) => !o.ok)!;
		expect(crashed.error).toMatch(/worker exited/);

		// The other call must have recovered on a fresh worker
		// (not hung or timed out).
		const recovered = outcomes.find((o) => o.ok)!;
		expect(recovered.value).toEqual({ recovered: true });

		// Two workers: first (crashed via exit, NOT .terminate()d), second (fresh).
		expect(createdWorkers).toHaveLength(2);
		expect(createdWorkers[0].terminated).toBe(false);
		expect(createdWorkers[1].terminated).toBe(false);
	});
});
