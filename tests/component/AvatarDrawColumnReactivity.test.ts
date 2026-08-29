/* @vitest-environment happy-dom */

/**
 * Guards that an avatar comparison drives the columns the GRID is watching.
 *
 * `sendAvatarDraw` builds its new columns as plain objects, concatenates them
 * onto any already-drawn portraits, and assigns the result into `this.columns`.
 * That assignment is what makes them reactive; the first READ of an element is
 * what detaches them, because it materializes that element's `$state` proxy into
 * the array — after which the plain object it was built from is no longer what
 * anyone reads. A branch drives its column by MUTATING it (status, segments,
 * persisted), so handing the dispatcher the plain objects sends every one of
 * those writes somewhere `this.columns` never sees. And the thing doing the
 * reading is the grid, so the detachment happens exactly when the feature is
 * being used.
 *
 * The failure is not subtle once it happens, but it is invisible where you'd
 * look for it. The grid sits on "Queued" for the whole draw; then the resolution
 * step reads back two branches that produced nothing, wipes the comparison and
 * announces that no model drew a portrait — for a draw that in fact succeeded
 * twice. What rescues the screen is the server-truth rebuild that the wipe's
 * `invalidateAll` triggers, which quietly puts up a RECOVERED grid holding the
 * real portraits. So the bug shipped looking almost right, and gave itself away
 * only by the one control a recovered grid withholds (Regenerate).
 *
 * THE TRAP, and why this file is happy-dom while the controller's other tests
 * are node: under vitest's default `node` environment Svelte resolves to the SSR
 * runtime, where `$state` does not proxy at all — the plain object and the array
 * element are then literally the same object, the mutations land, and the whole
 * defect disappears. `tests/unit/fanout-controller.test.ts` asserts these exact
 * statuses and passed throughout.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ invalidateAll: async () => {} }));
vi.mock('$lib/title-pending.svelte', () => ({
	markTitlePending: vi.fn(),
	clearTitlePending: vi.fn(),
}));

import { FanoutController, type FanoutDeps } from '$lib/fanout-controller.svelte';
import { trackReactive } from './_reactive-probe.svelte';
import type { ChatMessage } from '$lib/types/api';

function portrait(id: string, modelUsed: string): ChatMessage {
	return {
		id,
		role: 'assistant',
		parts: [{ type: 'image', mediaId: `${id}-media` }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 1,
		sourceMediaId: null,
	} as unknown as ChatMessage;
}

function sseResponse(events: unknown[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
			controller.close();
		},
	});
	return { ok: true, body } as unknown as Response;
}

function makeController(errors: string[]) {
	const deps: FanoutDeps = {
		convId: () => 'c1',
		models: () => [],
		messageCount: () => 0,
		busy: () => false,
		appendUserMessage: () => {},
		setBusy: () => {},
		setError: (m) => {
			if (m) errors.push(m);
		},
		setActiveModel: () => {},
		setStreamedMessageId: () => {},
		interrupted: () => false,
		clearInterruptedFlags: () => {},
		scrollToBottom: () => {},
	};
	return new FanoutController(deps);
}

describe('an avatar comparison drives the reactive columns', () => {
	it('settles every branch it dispatched', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: { body?: string }) => {
				if (url.endsWith('/avatar/prepare')) {
					// One portrait already drawn here, so the new branches sit at a
					// non-zero offset in `columns` — the case an index slip would miss.
					return {
						ok: true,
						json: async () => ({ siblings: [portrait('old', 'bridge::sdxl')] }),
					} as unknown as Response;
				}
				const { modelId } = JSON.parse(init?.body ?? '{}') as { modelId: string };
				return sseResponse([
					{ type: 'start', userMessage: portrait('desc', ''), assistantMessageId: '' },
					{ type: 'done', assistantMessage: portrait(`out-${modelId}`, modelId) },
				]);
			}),
		);
		const errors: string[] = [];
		const fc = makeController(errors);

		// A live subscriber reading the columns per-element, which is what the grid
		// is. This is load-bearing, not scenery: reading an element is what
		// materializes its `$state` proxy into the array, and that is the moment the
		// plain object the column was built from stops being what anyone reads.
		// Without a reader mid-flight the raw objects stay in place, the mutations
		// land on them, and a broken dispatch looks perfectly healthy.
		const probe = trackReactive(() => fc.columns.map((c) => `${c.status}:${!!c.persisted}`).join());

		await fc.sendAvatarDraw({
			sourceMessageId: 'desc',
			prompt: 'a weathered navigator',
			enhance: true,
			branches: [
				{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL' },
				{ modelId: 'bridge::flux', modelKind: 'image', displayName: 'Flux' },
			],
		});

		// The seeded portrait plus both new ones, all settled with a persisted row.
		expect(fc.columns.map((c) => c.status)).toEqual(['done', 'done', 'done']);
		expect(fc.columns.every((c) => c.persisted !== null)).toBe(true);
		// The grid is still up and still this page's, which is what keeps the
		// reviewed prompt (and so Regenerate) available.
		expect(fc.comparing).toBe(true);
		expect(fc.canRegenerate).toBe(true);
		// And nothing told the user their draw came back empty.
		expect(errors).toEqual([]);

		probe.dispose();
		vi.unstubAllGlobals();
	});
});
