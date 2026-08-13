/* @vitest-environment happy-dom */

/**
 * Guards the reactivity contract between ChatTurnController.inFlightSegments and
 * the chat page's rAF markdown pump.
 *
 * The pump (chat/[id]/+page.svelte) renders each streaming text segment's HTML
 * on the next frame and writes it back IN PLACE — `s.html = …` — deliberately
 * NOT reassigning the array, because reassigning re-triggers the very effect
 * that iterates it and yanks the scroll to the bottom at 60Hz. That in-place
 * write is only observable because `inFlightSegments` is a DEEP `$state`, whose
 * proxy wraps each element.
 *
 * Switching the field to `$state.raw` silently breaks this: elements become
 * plain objects, `s.html = …` notifies nothing, and `inFlightBlocks` recomputes
 * only when the next SSE event reassigns the array. The bubble then renders a
 * chunk behind — and the newest text is not shown even as plain text, because
 * inFlightToBlocks stops falling back once `seg.html` is set.
 *
 * TWO TRAPS make a naive version of this test pass against the broken code:
 *
 *   1. Environment. Under vitest's default `node` environment Svelte resolves to
 *      the SSR runtime, where effects never run — the test would assert nothing.
 *      Hence the happy-dom header above; see tests/component/README.md.
 *   2. Reading the derived OUTSIDE an effect owner recomputes it eagerly, which
 *      masks the missing notification. The consumer below must therefore be a
 *      real `$effect` inside `$effect.root`, reading through `flushSync`.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { ChatTurnController } from '$lib/chat-turn-controller.svelte';
import { appendText } from '$lib/chat-render';
import type { RenderBlock } from '$lib/chat-render';
import { trackReactive } from './_reactive-probe.svelte';

/** Minimal deps — this suite only exercises the segments/blocks reactivity. */
function makeController(): ChatTurnController {
	return new ChatTurnController({
		convId: () => 'c-1',
		getMessages: () => [],
		setMessages: () => {},
		modelId: () => 'e::m',
		modelKind: () => 'chat',
		setError: () => {},
		setApprovalError: () => {},
		clearApprovalDecisions: () => {},
		setTitle: () => {},
		applyCanvas: () => {},
		isNearBottom: () => true,
		scrollToBottom: () => {},
		serverInFlightSince: () => null,
		fanoutComparing: () => false,
	});
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

/**
 * Subscribe to `turn.inFlightBlocks` the way the component does — from inside a
 * real effect — and record every value the reactive graph publishes.
 */
function trackBlocks(turn: ChatTurnController): RenderBlock[][] {
	const { seen, dispose } = trackReactive(() => turn.inFlightBlocks);
	cleanups.push(dispose);
	return seen;
}

describe('inFlightSegments — in-place segment writes must be observable', () => {
	it('publishes an in-place s.html write without reassigning the array', () => {
		const turn = makeController();
		const seen = trackBlocks(turn);

		// A chunk arrives: appendText reassigns, so the derived recomputes and
		// renders the plain-text fallback (no html yet).
		turn.inFlightSegments = appendText(turn.inFlightSegments, 'hello');
		flushSync();
		expect(seen.at(-1)).toEqual([{ type: 'plain-text', text: 'hello' }]);

		// The rAF pump's write, verbatim: mutate the element, do NOT reassign.
		// This is the line that goes silent under $state.raw.
		const seg = turn.inFlightSegments[0];
		if (seg.kind !== 'text') throw new Error('expected a text segment');
		seg.html = '<p>hello</p>';
		seg.htmlFromText = 'hello';
		flushSync();

		expect(seen.at(-1)).toEqual([{ type: 'html', html: '<p>hello</p>' }]);
	});

	it('does not leave the render a chunk behind across successive writes', () => {
		const turn = makeController();
		const seen = trackBlocks(turn);

		turn.inFlightSegments = appendText(turn.inFlightSegments, 'hello');
		flushSync();
		const first = turn.inFlightSegments[0];
		if (first.kind !== 'text') throw new Error('expected a text segment');
		first.html = '<p>hello</p>';
		first.htmlFromText = 'hello';
		flushSync();

		// Second chunk grows the same segment. appendText carries `html` forward,
		// so without the in-place write being observable the renderer would still
		// be showing "<p>hello</p>" here.
		turn.inFlightSegments = appendText(turn.inFlightSegments, ' world');
		flushSync();
		const second = turn.inFlightSegments[0];
		if (second.kind !== 'text') throw new Error('expected a text segment');
		expect(second.text).toBe('hello world');
		second.html = '<p>hello world</p>';
		second.htmlFromText = 'hello world';
		flushSync();

		expect(seen.at(-1)).toEqual([{ type: 'html', html: '<p>hello world</p>' }]);
	});

	it('publishes the final render when no further chunk arrives', () => {
		// The worst case: a text run followed by a long tool call keeps the
		// in-flight bubble mounted, so a tail that is never republished stays
		// invisible for the tool's whole duration.
		const turn = makeController();
		const seen = trackBlocks(turn);

		turn.inFlightSegments = appendText(turn.inFlightSegments, 'tail');
		flushSync();
		const seg = turn.inFlightSegments[0];
		if (seg.kind !== 'text') throw new Error('expected a text segment');
		seg.html = '<p>tail</p>';
		seg.htmlFromText = 'tail';
		flushSync();

		// No further reassignment — the last value the graph published must
		// already be the rendered HTML.
		expect(seen.at(-1)).toEqual([{ type: 'html', html: '<p>tail</p>' }]);
	});
});
