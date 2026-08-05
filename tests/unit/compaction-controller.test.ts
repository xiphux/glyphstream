/**
 * Unit tests for the extracted compaction controller. Instantiated with mock
 * deps + a fetch stub, so the manual / auto / undo flows are exercised without a
 * live page or backend. $app/navigation, the toast host and the confirm dialog
 * are module-mocked; the controller runs its real runes (the sveltekit() vitest
 * plugin compiles the .svelte.ts module). Mirrors chat-turn-controller.test.ts.
 *
 * The thing most worth pinning down is the shared precondition. Three entry
 * points (manual compact, auto-compact-before-send, undo) must all refuse while
 * a turn is streaming or a fan-out comparison is parked — compaction advances
 * the active leaf, which would silently drop a parked compare grid. Inline in
 * the page these were three hand-copied early returns; here they're one getter,
 * and these tests are what holds that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invalidateAll = vi.fn(async () => {});
vi.mock('$app/navigation', () => ({ invalidateAll: () => invalidateAll() }));

const toastCalls = vi.hoisted(() => ({
	success: [] as unknown[],
	error: [] as unknown[],
	info: [] as unknown[],
}));
vi.mock('$lib/toast.svelte', () => ({
	toast: {
		success: (m: string, o?: unknown) => toastCalls.success.push([m, o]),
		error: (m: string) => toastCalls.error.push(m),
		info: (m: string) => toastCalls.info.push(m),
	},
}));

const confirmAsk = vi.hoisted(() => vi.fn(async () => true));
vi.mock('$lib/confirm.svelte', () => ({ confirmDialog: { ask: confirmAsk } }));

import { CompactionController, type CompactionDeps } from '$lib/compaction-controller.svelte';
import type { ChatMessage } from '$lib/types/api';

/**
 * A branch long enough that `compactionWorthwhile` says yes.
 *
 * The assistant rows carry reported usage on purpose: `shouldAutoCompact` reads
 * the live size from the newest assistant turn's `tokensIn`/`tokensOut`, so a
 * branch without usage measures 0 and every auto-compaction test would pass
 * vacuously down the "under threshold" early return.
 */
function longBranch(): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let i = 0; i < 24; i++) {
		const assistant = i % 2 === 1;
		out.push({
			id: `m${i}`,
			role: assistant ? 'assistant' : 'user',
			parts: [{ type: 'text', text: 'x'.repeat(400) }],
			createdAt: 1000 + i,
			...(assistant ? { tokensIn: 6000, tokensOut: 200 } : {}),
		} as ChatMessage);
	}
	return out;
}

function makeDeps(overrides: Partial<CompactionDeps> = {}) {
	const state = {
		convId: 'c1',
		messages: longBranch(),
		turnBusy: false,
		fanoutComparing: false,
		contextWindow: 8000 as number | null,
		autoEnabled: true,
		autoThreshold: 80,
		compactedWith: [] as string[],
	};
	const deps: CompactionDeps = {
		convId: () => state.convId,
		getMessages: () => state.messages,
		turnBusy: () => state.turnBusy,
		fanoutComparing: () => state.fanoutComparing,
		contextWindow: () => state.contextWindow,
		autoCompactionEnabled: () => state.autoEnabled,
		autoCompactionThreshold: () => state.autoThreshold,
		onCompacted: (id) => {
			state.compactedWith.push(id);
		},
		...overrides,
	};
	return { deps, state };
}

/** A streamed (SSE) response — `data: {json}\n\n` per event, as readSSE parses.
 *  Dispatch is on the JSON's own `type`, not the SSE `event:` name. */
function sseResponse(events: unknown[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
			controller.close();
		},
	});
	return { ok: true, status: 200, body } as unknown as Response;
}

/** A compact response that streams start → text → done. */
function sseCompactOk(summaryId = 's1'): Response {
	return sseResponse([
		{ type: 'compaction_start' },
		{ type: 'compaction_text', chunk: 'a summary' },
		{ type: 'compaction_done', summaryMessage: { id: summaryId, role: 'assistant', parts: [] } },
	]);
}

beforeEach(() => {
	invalidateAll.mockClear();
	confirmAsk.mockClear();
	confirmAsk.mockResolvedValue(true);
	toastCalls.success.length = 0;
	toastCalls.error.length = 0;
	toastCalls.info.length = 0;
});

describe('the shared precondition', () => {
	it('refuses all three flows while a turn is streaming', async () => {
		const { deps, state } = makeDeps();
		state.turnBusy = true;
		const c = new CompactionController(deps);
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		expect(c.compactable).toBe(false);
		expect(await c.compact()).toEqual({ status: 'noop' });
		await c.undo();
		expect(await c.maybeAutoCompact()).toBe(true);

		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('refuses all three flows while a fan-out comparison is parked', async () => {
		// Compaction advances the active leaf, which resolves the parked fan-out
		// and would silently drop the compare grid.
		const { deps, state } = makeDeps();
		state.fanoutComparing = true;
		const c = new CompactionController(deps);
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		expect(c.compactable).toBe(false);
		expect(await c.compact()).toEqual({ status: 'noop' });
		await c.undo();
		expect(await c.maybeAutoCompact()).toBe(true);

		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('refuses a second compaction while one is already in flight', async () => {
		const { deps } = makeDeps();
		const c = new CompactionController(deps);
		let release!: () => void;
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			() => new Promise<Response>((res) => (release = () => res(sseCompactOk()))),
		);

		const first = c.compact();
		await Promise.resolve();
		expect(c.compacting).toBe(true);
		expect(await c.compact()).toEqual({ status: 'noop' });

		release();
		await first;
		vi.restoreAllMocks();
	});
});

describe('manual compaction', () => {
	it('streams the summary, refetches, toasts, and hands the id to the page', async () => {
		const { deps, state } = makeDeps();
		const c = new CompactionController(deps);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseCompactOk('summary-42'));

		const outcome = await c.compact();

		expect(outcome).toEqual({ status: 'compacted' });
		expect(invalidateAll).toHaveBeenCalled();
		expect(toastCalls.success).toHaveLength(1);
		// The page — not the controller — owns the scroll/highlight.
		expect(state.compactedWith).toEqual(['summary-42']);
		// Latches settle regardless of path.
		expect(c.compacting).toBe(false);
		expect(c.streaming).toBe(false);
		expect(c.streamText).toBe('');
		vi.restoreAllMocks();
	});

	it('treats 409 as a no-op, not a failure', async () => {
		const { deps } = makeDeps();
		const c = new CompactionController(deps);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 409 }));

		expect(await c.compact()).toEqual({ status: 'noop' });
		expect(toastCalls.error).toHaveLength(1);
		vi.restoreAllMocks();
	});

	it('reports a transport failure as an error outcome', async () => {
		const { deps } = makeDeps();
		const c = new CompactionController(deps);
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

		const outcome = await c.compact();
		expect(outcome.status).toBe('error');
		expect(c.compacting).toBe(false);
		vi.restoreAllMocks();
	});

	it('silent mode emits no toasts and skips the scroll callback', async () => {
		const { deps, state } = makeDeps();
		const c = new CompactionController(deps);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseCompactOk());

		await c.compact({ silent: true });

		expect(toastCalls.success).toHaveLength(0);
		expect(toastCalls.error).toHaveLength(0);
		expect(state.compactedWith).toEqual([]);
		vi.restoreAllMocks();
	});
});

describe('undo', () => {
	it('DELETEs, refetches and confirms', async () => {
		const { deps } = makeDeps();
		const c = new CompactionController(deps);
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 200 }));

		await c.undo();

		expect(fetchSpy).toHaveBeenCalledWith('/api/conversations/c1/compact', { method: 'DELETE' });
		expect(toastCalls.success).toHaveLength(1);
		vi.restoreAllMocks();
	});

	it('stays neutral on 409 — the summary is no longer the leaf', async () => {
		const { deps } = makeDeps();
		const c = new CompactionController(deps);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 409 }));

		await c.undo();

		expect(toastCalls.success).toHaveLength(0);
		expect(String(toastCalls.error[0])).toMatch(/no longer the latest message/);
		vi.restoreAllMocks();
	});

	it('still reports success when only the view refresh fails', async () => {
		// The server committed the revert before replying, so the undo DID happen —
		// claiming failure here would be a lie.
		const { deps } = makeDeps();
		const c = new CompactionController(deps);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
		invalidateAll.mockRejectedValueOnce(new Error('load failed'));

		await c.undo();

		expect(toastCalls.error).toHaveLength(0);
		expect(String(toastCalls.info[0])).toMatch(/undone/);
		vi.restoreAllMocks();
	});
});

describe('auto-compaction before a send', () => {
	it('proceeds without compacting when the preference is off', async () => {
		const { deps, state } = makeDeps();
		state.autoEnabled = false;
		const c = new CompactionController(deps);
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		expect(await c.maybeAutoCompact()).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('proceeds without compacting when under the threshold', async () => {
		const { deps, state } = makeDeps();
		state.contextWindow = 10_000_000; // 6.2k reported is nowhere near 80% of this
		const c = new CompactionController(deps);
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		expect(await c.maybeAutoCompact()).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('compacts silently and proceeds once over the threshold', async () => {
		const { deps, state } = makeDeps();
		state.contextWindow = 7000; // 6.2k reported is >80%
		const c = new CompactionController(deps);
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseCompactOk());

		expect(await c.maybeAutoCompact()).toBe(true);
		// Assert it actually compacted. `true` is also what the under-threshold
		// early return yields, so without this the test passes either way.
		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/conversations/c1/compact?stream=1',
			expect.objectContaining({ method: 'POST' }),
		);
		expect(toastCalls.success).toHaveLength(0); // silent
		expect(confirmAsk).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it('asks before sending when the compaction fails, and honors a cancel', async () => {
		// A failed compaction means the full context ships — which may blow the
		// window — so this must not be swallowed.
		const { deps, state } = makeDeps();
		state.contextWindow = 7000;
		const c = new CompactionController(deps);
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('upstream down'));
		confirmAsk.mockResolvedValue(false);

		expect(await c.maybeAutoCompact()).toBe(false);
		expect(confirmAsk).toHaveBeenCalled();
		vi.restoreAllMocks();
	});
});
