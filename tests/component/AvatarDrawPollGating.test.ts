/* @vitest-environment happy-dom */

/**
 * Guards the reactivity contract behind the avatar-draw recovery poll.
 *
 * The chat page arms that poll with
 *
 *     $effect(() => {
 *         if (!avatarDraw.recovered) return;
 *         return avatarDraw.startRecoveryPoll();
 *     });
 *
 * so the effect's dependency set decides how often the 4s interval is torn down
 * and rebuilt. `recovered` is therefore a `$derived` field on the controller
 * rather than a plain getter like its two neighbours: a getter read inside an
 * effect subscribes that effect to every source it touches, `#draw` included —
 * and `setStatus` reassigns `#draw` on every progress frame. The effect would
 * re-run several times a second, each time clearing the interval and starting a
 * fresh one, so the poll's window would never elapse and no probe would ever
 * fire.
 *
 * That is not hypothetical: it is reachable exactly where this controller earns
 * its keep. A draw streaming in conversation B rewrites `#draw` at ComfyUI's
 * step rate while the user stands in A, whose own draw was recovered from the
 * page load — so A's ring spins and its Draw action stays disabled for the whole
 * of B's draw, with the poll that would have cleared it starved.
 *
 * THE TRAPS, both called out in _reactive-probe.svelte and worth restating
 * because this suite walks into range of the second:
 *
 *   1. Environment. Under vitest's default `node` environment Svelte resolves to
 *      the SSR runtime and effects never run. Hence the header above.
 *   2. This file's central assertion is that a re-run did NOT happen, which is
 *      the shape that passes for the wrong reason when nothing was recorded at
 *      all. Every test below therefore proves the probe is live — by asserting a
 *      recorded value first, and by driving a real transition afterwards — so a
 *      broken harness fails instead of silently agreeing.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { AvatarDrawController } from '$lib/avatar-draw-controller.svelte';
import { reactiveBox, trackReactive } from './_reactive-probe.svelte';

let dispose: (() => void) | null = null;
afterEach(() => {
	dispose?.();
	dispose = null;
});

/**
 * A controller plus a mutable handle on the conversation the "page" shows.
 *
 * `convId` is a reactive box, not a plain field: the gate reads it through the
 * deps getter, and this suite asserts on what the reactive graph publishes. A
 * plain field would make a navigation invisible to the derived, so the
 * navigation test below would fail against perfectly correct code.
 */
function setup(startOn: string, serverDrawSince: number | null) {
	const page = reactiveBox(startOn);
	const c = new AvatarDrawController({ convId: () => page.value }, serverDrawSince);
	return { c, page };
}

describe('the poll gate', () => {
	it('does not re-publish while a draw streams in another conversation', () => {
		// A has a draw recovered from its load; the client is driving B's.
		const { c } = setup('A', 5000);
		const probe = trackReactive(() => c.recovered);
		dispose = probe.dispose;

		// The probe is live and A is armed — assert a real value before asserting
		// an absence, or a dead harness would agree with us for free.
		expect(probe.seen).toEqual([true]);

		for (let i = 0; i < 5; i++) {
			c.setStatus('B', `Drawing… ${i}`);
			flushSync();
		}

		// Five progress frames, no republication: the gate still says "armed" and
		// the page's effect never tore its interval down.
		expect(probe.seen).toEqual([true]);
		expect(c.recovered).toBe(true);
	});

	it('still publishes when the gate genuinely flips', () => {
		// The other half of the same contract: memoizing must not make the value
		// go stale. Without this, a `recovered` hardcoded to its first reading
		// would pass the test above.
		const { c } = setup('A', 5000);
		const probe = trackReactive(() => c.recovered);
		dispose = probe.dispose;
		expect(probe.seen).toEqual([true]);

		// The draw finished: the load's mirror clears, the poll should disarm.
		c.syncFromServer(null);
		flushSync();
		expect(probe.seen).toEqual([true, false]);

		// And re-arms when a probe finds another draw running.
		c.syncFromServer(9000);
		flushSync();
		expect(probe.seen).toEqual([true, false, true]);
	});

	it('publishes when a local draw takes over the conversation on screen', () => {
		// `recovered` means "running server-side with nobody driving it", so a
		// local draw for the conversation on screen must disarm the poll — this is
		// the one `setStatus` that SHOULD republish, and it shares a source with
		// the ones that must not.
		const { c } = setup('A', 5000);
		const probe = trackReactive(() => c.recovered);
		dispose = probe.dispose;
		expect(probe.seen).toEqual([true]);

		c.setStatus('A', 'Drawing…');
		flushSync();
		expect(probe.seen).toEqual([true, false]);

		// …and re-arms once that local closure lets go.
		c.end('A');
		flushSync();
		expect(probe.seen).toEqual([true, false, true]);
	});

	it('follows the conversation on screen', () => {
		// The gate reads `convId` through the deps getter, so navigating away from
		// a locally-driven draw must re-publish: the draw is still running, but
		// from B's point of view nobody is driving it, which is what arms the poll.
		const { c, page } = setup('A', 5000);
		c.setStatus('A', 'Drawing…');
		const probe = trackReactive(() => c.recovered);
		dispose = probe.dispose;
		expect(probe.seen).toEqual([false]);

		page.value = 'B';
		flushSync();
		expect(probe.seen).toEqual([false, true]);

		// And back: A is driving its own draw again, so the poll disarms.
		page.value = 'A';
		flushSync();
		expect(probe.seen).toEqual([false, true, false]);
	});
});
