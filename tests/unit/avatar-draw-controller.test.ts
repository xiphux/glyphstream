/**
 * Unit tests for the extracted avatar-draw recovery controller.
 *
 * These exist because of how they came about. This state machine spent four
 * rounds of review living inline in the chat page, where nothing could
 * instantiate it, and three of those four rounds found a regression introduced
 * by the previous round's fix. Every scenario below is one of those bugs, so a
 * reintroduction fails here rather than being re-derived by a reviewer.
 *
 * Instantiated with a mock `convId` getter and a fetch stub, like
 * chat-turn-controller.test.ts and fanout-controller.test.ts — the controller
 * runs its real runes (the sveltekit() vitest plugin compiles the .svelte.ts
 * module). `$app/navigation` and the toast singleton are module-mocked so the
 * two things the controller does to the outside world are observable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invalidateAll = vi.fn(async () => {});
vi.mock('$app/navigation', () => ({ invalidateAll: () => invalidateAll() }));

const toastError = vi.fn<(message: string) => void>();
vi.mock('$lib/toast.svelte', () => ({
	toast: {
		error: (m: string) => {
			toastError(m);
		},
	},
}));

import { AvatarDrawController } from '$lib/avatar-draw-controller.svelte';

/** A controller plus a handle on the conversation the "page" is showing. */
function setup(startOn = 'A', serverDrawSince: number | null = null) {
	const page = { convId: startOn };
	const c = new AvatarDrawController({ convId: () => page.convId }, serverDrawSince);
	return { c, page };
}

/**
 * Stub `fetch` for one probe and hand the mock back, so callers can assert on
 * the URL. `running` seeds `avatarDrawSince`.
 *
 * Returning the mock matters more than it looks: without a URL assertion
 * somewhere, dropping `?fanout=1` — the branch-walk-free variant this whole
 * design exists to use instead of a full-conversation reload — is invisible to
 * every test in the file, and so is probing the conversation on screen rather
 * than the one the draw belongs to.
 */
function stubProbe(result: { ok?: boolean; running?: number | null } | Error) {
	const mock =
		result instanceof Error
			? vi.fn(() => Promise.reject(result))
			: vi.fn(() =>
					Promise.resolve({
						ok: result.ok ?? true,
						status: (result.ok ?? true) ? 200 : 500,
						json: () => Promise.resolve({ avatarDrawSince: result.running ?? null }),
					}),
				);
	vi.stubGlobal('fetch', mock);
	return mock;
}

beforeEach(() => {
	// `mockReset`, not `mockClear`: a queued `mockRejectedValueOnce` that its own
	// test failed to consume would otherwise leak into the next one and surface
	// as a confusing cascade instead of a single clean failure.
	invalidateAll.mockReset();
	invalidateAll.mockImplementation(async () => {});
	toastError.mockReset();
	vi.unstubAllGlobals();
	// Belt-and-braces against a future timer test written without its own
	// `finally` — one leak here would poison every test after it in file order.
	vi.useRealTimers();
});

describe('the ring', () => {
	it('shows the local draw only in its own conversation', () => {
		// The page component is REUSED across /chat/[a] → /chat/[b] and the draw
		// deliberately survives the switch, so scoping is what keeps A's progress
		// out of B's header.
		const { c, page } = setup('A');
		c.setStatus('A', 'Drawing…');
		expect(c.status).toBe('Drawing…');

		page.convId = 'B';
		expect(c.status).toBeNull();

		page.convId = 'A';
		expect(c.status).toBe('Drawing…');
	});

	it('falls back to server truth so a killed connection does not hide the draw', () => {
		// The whole point of the mirror: iOS kills the fetch, the local slot is
		// gone, and without this the header claims nothing is happening for the
		// minutes the draw has left.
		const { c } = setup('A', 1000);
		expect(c.status).toBe('Drawing…');
		expect(c.recovered).toBe(true);
	});

	it('does not report a recovered draw while a local closure is driving one', () => {
		// Otherwise the page would arm its poll on top of its own live stream.
		const { c } = setup('A', 1000);
		c.setStatus('A', 'Drawing…');
		expect(c.recovered).toBe(false);
	});
});

describe('interruption latching', () => {
	it('latches only for a draw in the conversation on screen', async () => {
		// Round 1: an unscoped read stayed true while the user stood in another
		// thread, so every hide latched and every resume reconciled — against the
		// conversation they were standing in, which the draw cannot touch.
		const { c, page } = setup('A');
		c.setStatus('A', 'Drawing…');

		page.convId = 'B';
		c.markInterrupted();
		expect(c.debug.interruptedFor).toBeNull();
		expect(c.debug.owedFor).toBeNull();

		page.convId = 'A';
		c.markInterrupted();
		expect(c.debug.interruptedFor).toBe('A');
		expect(c.debug.owedFor).toBe('A');
	});

	it("does not let one draw's teardown clear another's latch", () => {
		// Round 3: two draws overlap (start in A, navigate to B, start another —
		// the page's guard is convId-scoped, so B's is allowed). An unguarded clear
		// is how A's teardown makes B stop recognising its own interruption, so B
		// surfaces the false "Load failed" this whole feature exists to stop.
		const { c, page } = setup('A');
		c.setStatus('A', 'Drawing…');
		c.markInterrupted(); // latch = A

		page.convId = 'B';
		c.setStatus('B', 'Drawing…');
		c.markInterrupted(); // latch = B

		c.end('A'); // A's draw settles second
		expect(c.wasInterrupted('B')).toBe(true);
	});

	it('a new draw clears only its own stale latch', () => {
		const { c } = setup('A');
		c.setStatus('A', 'Drawing…');
		c.markInterrupted();

		c.begin('B');
		expect(c.wasInterrupted('A')).toBe(true);
		c.begin('A');
		expect(c.wasInterrupted('A')).toBe(false);
	});
});

describe('the reconcile debt', () => {
	it('survives a probe that could not reach the server, so the next resume retries', async () => {
		// Round 2: clearing the debt on ATTEMPT is how an offline interruption ends
		// up abandoned — the retry hook is gone and the poll cannot take over,
		// because what arms the poll is the mirror only a successful probe seeds.
		const { c } = setup('A');
		c.setStatus('A', 'Drawing…');
		c.markInterrupted();

		stubProbe(new TypeError('Load failed'));
		await c.reconcile('A');
		expect(c.debug.owedFor).toBe('A');

		// Network back: the retry discharges it and seeds the mirror.
		stubProbe({ running: 5000 });
		await c.reconcile('A');
		expect(c.debug.owedFor).toBeNull();
		expect(c.recovered).toBe(false); // local draw still owns the slot
		c.end('A');
		expect(c.recovered).toBe(true); // …and now the poll can take it
	});

	it('is discharged by a draw that completed, even from another conversation', async () => {
		// Round 3: a hide arms the debt for any running draw without knowing
		// whether the connection actually died — and on desktop it usually didn't.
		// Left set, the next resume probes, learns nothing, and pays a full branch
		// reload. Discharging must not be gated on still viewing the conversation,
		// or a draw finishing while the user is elsewhere strands it.
		const { c, page } = setup('A');
		c.setStatus('A', 'Drawing…');
		c.markInterrupted();

		page.convId = 'B';
		c.completed('A');
		expect(c.debug.owedFor).toBeNull();

		page.convId = 'A';
		stubProbe({ running: null });
		expect(c.reconcileIfOwed()).toBe(false);
		expect(invalidateAll).not.toHaveBeenCalled();
	});

	it('is not probed for a conversation the user has left', () => {
		// Round 3: the probe's own scope checks would discard the answer, so
		// probing is a request made to be thrown away — on every focus, for as long
		// as they stay away.
		const { c, page } = setup('A');
		c.setStatus('A', 'Drawing…');
		c.markInterrupted();

		page.convId = 'B';
		const fetchMock = stubProbe({ running: null });
		expect(c.reconcileIfOwed()).toBe(false);
		// The named claim is that no REQUEST is made — asserting only the return
		// value would leave a version that probes and discards the answer green.
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('the probe', () => {
	it('reloads once when the draw is over, and seeds the mirror when it is not', async () => {
		const { c } = setup('A');

		stubProbe({ running: 7000 });
		await c.reconcile('A');
		expect(invalidateAll).not.toHaveBeenCalled();
		expect(c.status).toBe('Drawing…');

		stubProbe({ running: null });
		await c.reconcile('A');
		expect(invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('writes nothing for a conversation the user has navigated away from', async () => {
		// Seeding B's mirror from A's draw would paint a phantom ring on B, disable
		// B's Draw action, and arm a poll that reloads B.
		const { c, page } = setup('A');
		let resolve!: (v: unknown) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(
				() =>
					new Promise((r) => {
						resolve = r;
					}),
			),
		);
		const inFlight = c.reconcile('A');
		page.convId = 'B';
		// `json` fails the test rather than returning a body: this test names the
		// check that runs BEFORE the body read, and without this it falls through
		// and is caught by the later one instead — passing while the check it is
		// named for could be deleted outright.
		resolve({
			ok: true,
			json: () => expect.fail('should have bailed before reading the body'),
		});
		await inFlight;

		expect(c.status).toBeNull();
		expect(invalidateAll).not.toHaveBeenCalled();
	});

	it('writes nothing when the user leaves DURING the body read', async () => {
		// The scope check after `res.json()` is separate from the one after `fetch`,
		// and both are load-bearing: `json()` is its own await, so the conversation
		// can change across it while the response itself arrived in time. Without
		// the second check a probe for A seeds B's mirror — the same phantom ring
		// and spurious poll the first check exists to prevent, one await later.
		const { c, page } = setup('A');
		let resolveBody!: (v: unknown) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					json: () =>
						new Promise((r) => {
							resolveBody = r;
						}),
				}),
			),
		);
		const inFlight = c.reconcile('A');
		// Let the fetch settle so we are parked inside `json()`, then navigate.
		await Promise.resolve();
		await Promise.resolve();
		// Assert we really are mid-probe rather than trusting the tick count. If a
		// refactor moved a scope check earlier, this test could otherwise pass via
		// that one while no longer exercising the post-body check it is named for.
		expect(c.debug.probingFor).toBe('A');
		page.convId = 'B';
		resolveBody({ avatarDrawSince: 7000 });
		await inFlight;

		expect(c.status).toBeNull();
		expect(invalidateAll).not.toHaveBeenCalled();
	});

	it('reports the failure message when the server answers but not with an answer', async () => {
		// Round 4: a reachable-but-erroring server used to return in silence. The
		// message is a one-shot — the draw's failure path is the only caller that
		// supplies one, every retry passes none — so silence lost it for good.
		const { c } = setup('A');
		stubProbe({ ok: false });
		await c.reconcile('A', 'ComfyUI ran out of memory');

		expect(toastError).toHaveBeenCalledWith('ComfyUI ran out of memory');
		// …and the debt stays, since a non-2xx says nothing about the draw.
		c.setStatus('A', 'Drawing…');
		c.markInterrupted();
		stubProbe({ ok: false });
		await c.reconcile('A');
		expect(c.debug.owedFor).toBe('A');
	});

	it('reports the failure message when it cannot reach the server at all', async () => {
		const { c } = setup('A');
		stubProbe(new TypeError('Load failed'));
		await c.reconcile('A', 'upstream exploded');
		expect(toastError).toHaveBeenCalledWith('upstream exploded');
	});

	it('never toasts the same failure twice when the reload rejects', async () => {
		// The confirmed-over branch toasts and then awaits the reload; a rejection
		// there falls into the catch, which would otherwise repeat it.
		const { c } = setup('A');
		stubProbe({ running: null });
		invalidateAll.mockRejectedValueOnce(new Error('reload failed'));
		await c.reconcile('A', 'upstream exploded');
		expect(toastError).toHaveBeenCalledTimes(1);
	});

	it('stays silent for a conversation the user has left, even with a message', async () => {
		// Not toasting into a thread they've moved on from is the point of the
		// scoping — this exit must NOT report.
		const { c, page } = setup('A');
		let resolve!: (v: unknown) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(
				() =>
					new Promise((r) => {
						resolve = r;
					}),
			),
		);
		const inFlight = c.reconcile('A', 'upstream exploded');
		page.convId = 'B';
		resolve({ ok: false });
		await inFlight;
		expect(toastError).not.toHaveBeenCalled();
	});

	it('collapses concurrent callers into one request and one reload', async () => {
		// Round 1/3: on one resume the visibility handler, the draw's own failure
		// path and a poll tick can all fire. Each used to buy its own full reload.
		const { c } = setup('A');
		stubProbe({ running: null });
		await Promise.all([c.reconcile('A'), c.reconcile('A'), c.reconcile('A')]);

		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
		expect(invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('releases the in-flight guard so a later probe still runs', async () => {
		const { c } = setup('A');
		stubProbe({ running: 7000 });
		await c.reconcile('A');
		expect(c.debug.probingFor).toBeNull();
		await c.reconcile('A');
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
	});
});

describe('what the probe deliberately does NOT report', () => {
	it('drops the message when the draw turns out to be still running', async () => {
		// The rule the docstring states and nothing pinned: a message is reported
		// only once the probe CONFIRMS the draw is over. Reporting it here is the
		// false-failure class this whole feature exists to remove — "ComfyUI ran
		// out of memory" fired at a draw that is drawing fine.
		const { c } = setup('A');
		stubProbe({ running: 7000 });
		await c.reconcile('A', 'ComfyUI ran out of memory');

		expect(toastError).not.toHaveBeenCalled();
		expect(invalidateAll).not.toHaveBeenCalled();
		expect(c.status).toBe('Drawing…');
	});

	it('stays silent when the request rejects for a conversation the user has left', async () => {
		// The symmetric half of "stays silent for a conversation the user has
		// left", which only ever exits through the non-2xx branch. A rejected
		// request must not toast into a thread the user has moved on from either.
		const { c, page } = setup('A');
		let reject!: (e: unknown) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(
				() =>
					new Promise((_r, rj) => {
						reject = rj;
					}),
			),
		);
		const inFlight = c.reconcile('A', 'boom');
		page.convId = 'B';
		reject(new TypeError('Load failed'));
		await inFlight;

		expect(toastError).not.toHaveBeenCalled();
	});
});

describe('the production entry points', () => {
	// The two methods the page actually calls when a draw dies and when the user
	// comes back. The properties below were all tested through `reconcile` and
	// `markInterrupted` directly, which left both of these wrappers free to be
	// gutted without failing anything.

	it('reportFailure arms the debt before probing, so a dead probe leaves a retry', async () => {
		// Round 2, restated at the entry point: without the debt, a failure whose
		// probe cannot reach the server leaves nothing for the next resume to try,
		// and the poll cannot take over because no mirror was ever seeded.
		const { c } = setup('A');
		stubProbe(new TypeError('Load failed'));
		c.reportFailure('A', 'boom');
		await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'));

		expect(c.debug.owedFor).toBe('A');
	});

	it('reportFailure forwards its message to the probe', async () => {
		// The suppression decision is made by the caller and carried through here;
		// dropping the argument would silently mute every reported failure.
		const { c } = setup('A');
		stubProbe({ running: null });
		c.reportFailure('A', 'ComfyUI ran out of memory');
		await vi.waitFor(() => expect(invalidateAll).toHaveBeenCalled());

		expect(toastError).toHaveBeenCalledWith('ComfyUI ran out of memory');
	});

	it('reconcileIfOwed actually probes when the debt is for the conversation on screen', async () => {
		// The resume path. Every other test asserted only the `false` return, so
		// the method could have returned true and never probed at all.
		const { c } = setup('A');
		c.setStatus('A', 'Drawing…');
		c.markInterrupted();
		c.end('A');
		const fetchMock = stubProbe({ running: 7000 });

		expect(c.reconcileIfOwed()).toBe(true);
		// Wait on the DISCHARGE, not on `fetch` having been called: the probe is
		// fired and forgotten, so the debt clears an await later.
		await vi.waitFor(() => expect(c.debug.owedFor).toBeNull());

		expect(fetchMock).toHaveBeenCalledWith('/api/conversations/A?fanout=1');
		expect(c.status).toBe('Drawing…');
	});
});

describe('the probe URL', () => {
	it("asks the light variant, about the draw's own conversation", async () => {
		// Two things no other assertion pins. `?fanout=1` is the branch-walk-free
		// variant — the entire performance rationale for probing instead of
		// reloading — and the id must be the draw's, not whatever is on screen,
		// or a probe would answer about the wrong thread.
		const { c, page } = setup('A');
		const fetchMock = stubProbe({ running: 7000 });
		page.convId = 'B';
		await c.reconcile('B');

		expect(fetchMock).toHaveBeenCalledWith('/api/conversations/B?fanout=1');
	});
});

describe('two draws at once', () => {
	// The configuration the conversation-scoped flags exist for, and the only one
	// in which their ownership guards differ from unguarded clears. Without a test
	// here, every `=== cid` guard in the module can be deleted with the suite
	// still green — which is how Round 3 shipped.

	it("one draw's teardown leaves the other's ring and debt alone", () => {
		const { c, page } = setup('A');
		// A is drawing; the user moves to B and starts a second draw, which takes
		// over the single slot.
		c.setStatus('A', 'Drawing…');
		page.convId = 'B';
		c.setStatus('B', 'Drawing…');
		c.markInterrupted(); // arms B's latch and debt

		// A's closure finally settles, long after it stopped owning anything.
		c.end('A');

		expect(c.status).toBe('Drawing…'); // B's ring survives
		expect(c.debug.interruptedFor).toBe('B');
		expect(c.debug.owedFor).toBe('B');
	});

	it("a probe for one conversation does not discharge the other's debt", async () => {
		const { c, page } = setup('A');
		c.setStatus('B', 'Drawing…');
		page.convId = 'B';
		c.markInterrupted(); // debt for B
		page.convId = 'A';

		// A probe for A answers while B's debt is outstanding.
		stubProbe({ running: 3000 });
		await c.reconcile('A');

		expect(c.debug.owedFor).toBe('B');
	});

	it("a completed draw does not discharge a different conversation's debt", () => {
		const { c, page } = setup('B');
		c.setStatus('B', 'Drawing…');
		c.markInterrupted(); // debt for B
		page.convId = 'A';

		c.completed('A');

		expect(c.debug.owedFor).toBe('B');
	});

	it("an older probe settling late does not release the newer one's guard", async () => {
		// The slot holds one conversation, so the hazard is ORDER: A starts, B
		// starts and takes the slot, then A finally settles. An unguarded release
		// in A's `finally` would free the guard while B is still in flight, and the
		// next caller for B would issue a duplicate probe and a duplicate reload.
		const { c } = setup('A');
		const release: Record<string, (v: unknown) => void> = {};
		const body = (since: number | null) => ({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ avatarDrawSince: since }),
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(
				(url: string) =>
					new Promise((r) => {
						release[String(url).includes('/B?') ? 'B' : 'A'] = r;
					}),
			),
		);

		const aInFlight = c.reconcile('A');
		await vi.waitFor(() => expect(release.A).toBeTypeOf('function'));
		const bInFlight = c.reconcile('B');
		await vi.waitFor(() => expect(release.B).toBeTypeOf('function'));
		expect(c.debug.probingFor).toBe('B');

		release.A(body(1));
		await aInFlight;
		expect(c.debug.probingFor).toBe('B');

		release.B(body(1));
		await bInFlight;
		expect(c.debug.probingFor).toBeNull();
	});
});

describe('the recovery poll', () => {
	it('probes on an interval and stops when torn down', async () => {
		vi.useFakeTimers();
		try {
			const { c } = setup('A', 1000);
			stubProbe({ running: 1000 });
			const stop = c.startRecoveryPoll();

			await vi.advanceTimersByTimeAsync(4000);
			expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(4000);
			expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

			stop();
			await vi.advanceTimersByTimeAsync(12_000);
			expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps retrying when the terminating reload rejects', async () => {
		// The obvious shape clears its own interval BEFORE awaiting the reload, so
		// a rejected reload leaves the ring spinning with nothing to re-arm it —
		// and `status` gates the Draw action, so the feature stays disabled.
		vi.useFakeTimers();
		try {
			const { c } = setup('A', 1000);
			stubProbe({ running: null });
			invalidateAll.mockRejectedValueOnce(new Error('reload failed'));
			const stop = c.startRecoveryPoll();

			await vi.advanceTimersByTimeAsync(4000);
			expect(invalidateAll).toHaveBeenCalledTimes(1);
			// Mirror untouched by the failed reload, so the gate is still true…
			expect(c.recovered).toBe(true);
			await vi.advanceTimersByTimeAsync(4000);
			expect(invalidateAll).toHaveBeenCalledTimes(2);
			stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('the recovery poll, continued', () => {
	it('keeps probing the conversation that armed it, not the one on screen', async () => {
		// A deliberate choice worth recording rather than a bug either way: the
		// poll pins its conversation at arm time and relies on the caller's effect
		// to tear it down and re-arm on navigation (see the page's `$effect` and
		// AvatarDrawPollGating). Reading `convId` per tick instead would make the
		// poll silently follow the user mid-flight, which nothing else would catch.
		vi.useFakeTimers();
		try {
			const { c, page } = setup('A', 5000);
			const fetchMock = stubProbe({ running: 5000 });
			const stop = c.startRecoveryPoll();

			page.convId = 'B';
			await vi.advanceTimersByTimeAsync(4000);

			expect(fetchMock).toHaveBeenCalledWith('/api/conversations/A?fanout=1');
			stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('syncFromServer', () => {
	it('arms the ring and the poll when a load discovers a draw', () => {
		// The direction that matters on a fresh navigation into a conversation
		// whose draw this client never saw start — nulling was covered, seeding
		// was not, so a `syncFromServer` that only ever cleared would have passed.
		const { c } = setup('A', null);
		expect(c.status).toBeNull();
		expect(c.recovered).toBe(false);

		c.syncFromServer(5000);

		expect(c.status).toBe('Drawing…');
		expect(c.recovered).toBe(true);
	});

	it('clears the ring when the load reports no draw', () => {
		const { c } = setup('A', 1000);
		expect(c.status).toBe('Drawing…');
		c.syncFromServer(null);
		expect(c.status).toBeNull();
		expect(c.recovered).toBe(false);
	});
});
