/**
 * Guards the reactivity contract of `FanoutController.columns`.
 *
 * `#runBranch` streams each branch by writing its column IN PLACE —
 * `col.status = 'streaming'`, `col.segments = appendText(…)`, `col.persisted =
 * …` — on the element it was handed out of `columns`. Those writes are only
 * observable because `columns` is a DEEP `$state`, whose proxy wraps each
 * element. Under `$state.raw` they notify nothing: the columns stop streaming
 * on screen, and `streaming` / `columnsSettled` stay stale until something
 * reassigns the array.
 *
 * Same shape as InFlightSegmentsReactivity, and for the same two reasons: it
 * must run under happy-dom (the SSR runtime never runs effects), and the
 * consumer must be a real `$effect`, since reading a `$derived` outside an
 * effect owner recomputes it eagerly and hides the missing notification.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';
import { FanoutController } from '#lib/fanout-controller.svelte.js';
import type { FanoutColumn } from '#lib/fanout.js';
import { appendText } from '#lib/chat-render.js';
import { trackReactive } from './_reactive-probe.svelte';

function makeController(): FanoutController {
	return new FanoutController({
		convId: () => 'c1',
		models: () => [],
		messageCount: () => 0,
		busy: () => false,
		appendUserMessage: () => {},
		setBusy: () => {},
		setError: () => {},
		setActiveModel: () => {},
		setStreamedMessageId: () => {},
		interrupted: () => false,
		clearInterruptedFlags: () => {},
		scrollToBottom: () => {},
	});
}

function column(i: number): FanoutColumn {
	return {
		branchId: `u1:${i}`,
		dispatchIndex: i,
		modelId: `e::m${i}`,
		modelKind: 'chat',
		label: `m${i}`,
		segments: [],
		status: 'queued',
		queuedAhead: 0,
		dispatching: true,
		progress: null,
		statusLabel: null,
		startedAt: null,
		inputMediaId: null,
		aspectRatio: null,
		persisted: null,
		error: null,
		errorMessageId: null,
	} as FanoutColumn;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

function track<T>(read: () => T): T[] {
	const { seen, dispose } = trackReactive(read);
	cleanups.push(dispose);
	return seen;
}

describe('FanoutController.columns — in-place column writes must be observable', () => {
	it("publishes a branch's streamed text without reassigning the array", () => {
		const fc = makeController();
		fc.columns = [column(0), column(1)];
		const seen = track(() => fc.columns.map((c) => c.segments.length));
		flushSync();

		const col = fc.columns[0];
		col.status = 'streaming';
		col.segments = appendText(col.segments, 'hello');
		flushSync();

		expect(seen.at(-1)).toEqual([1, 0]);
	});

	it('recomputes the derived flags from in-place status writes', () => {
		const fc = makeController();
		fc.columns = [column(0)];
		const streaming = track(() => fc.streaming);
		const settled = track(() => fc.columnsSettled);
		flushSync();
		expect(streaming.at(-1)).toBe(true);

		const col = fc.columns[0];
		col.status = 'error';
		col.error = 'boom';
		flushSync();

		expect(streaming.at(-1)).toBe(false);
		expect(settled.at(-1)).toBe(true);
	});
});
