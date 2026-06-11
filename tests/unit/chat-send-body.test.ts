/**
 * Wire-body construction tests for the chat-send pipeline.
 *
 * This is the regression-guard for an actual production bug: after
 * the server-side edit-routing refactor (commit 962cfb3) switched
 * the saveEdit flow to send `editedMessageId` instead of
 * `parentMessageId`, the chat page's inline requestBody construction
 * never started forwarding `editedMessageId` to the wire. The
 * server's resolveParentForUserMessage was tested in isolation and
 * worked correctly; the actual chat-page → server pipe was where
 * the field got silently dropped. By the time the user noticed,
 * all edits — root or not — were appending instead of branching.
 *
 * Pin every mode + every option combination that produced wire-shape
 * surprises, so the next refactor that touches request-body shape
 * fails fast here.
 */

import { describe, expect, it } from 'vitest';
import { buildSendRequestBody, buildFanoutBranchBody } from '$lib/chat-send-body';

const BASE = {
	text: 'hello world',
	attachedMediaIds: [],
	modelId: 'bridge::gpt-image-1',
	modelKind: 'image' as const,
};

describe('buildSendRequestBody', () => {
	it('returns the plain send shape when no options provided', () => {
		expect(buildSendRequestBody(BASE)).toEqual({
			text: 'hello world',
			attachedMediaIds: [],
			modelId: 'bridge::gpt-image-1',
			modelKind: 'image',
		});
	});

	it('forwards editedMessageId when set — REGRESSION GUARD', () => {
		// This is the specific test that catches the production bug
		// where edits silently appended instead of branching. The
		// previous inline body builder spread parentMessageId only;
		// editedMessageId fell off the wire entirely. If this test
		// fails, the chat page's send pipeline is dropping the edit
		// signal and edits won't branch.
		const body = buildSendRequestBody({
			...BASE,
			options: { editedMessageId: 'msg-123' },
		});
		expect(body.editedMessageId).toBe('msg-123');
	});

	it('forwards parentMessageId when set (legacy direct-parent override)', () => {
		const body = buildSendRequestBody({
			...BASE,
			options: { parentMessageId: 'msg-456' },
		});
		expect(body.parentMessageId).toBe('msg-456');
	});

	it('forwards both editedMessageId and parentMessageId when both are set', () => {
		// Precedence between the two is the *server*'s concern (see
		// resolveParentForUserMessage — editedMessageId wins). The
		// wire layer just transmits whatever the caller asked for.
		const body = buildSendRequestBody({
			...BASE,
			options: {
				editedMessageId: 'msg-edited',
				parentMessageId: 'msg-parent',
			},
		});
		expect(body.editedMessageId).toBe('msg-edited');
		expect(body.parentMessageId).toBe('msg-parent');
	});

	it('omits editedMessageId / parentMessageId when neither is set', () => {
		const body = buildSendRequestBody(BASE);
		expect(body).not.toHaveProperty('editedMessageId');
		expect(body).not.toHaveProperty('parentMessageId');
	});

	it('treats empty-string editedMessageId / parentMessageId as absent', () => {
		// Matches the server-side truthiness guard. An over-eager
		// client sending `""` (which JSON.stringify happily encodes)
		// shouldn't end up with a literal `editedMessageId: ""` in
		// the body — that would trip the server's 400 path.
		const body = buildSendRequestBody({
			...BASE,
			options: { editedMessageId: '', parentMessageId: '' },
		});
		expect(body).not.toHaveProperty('editedMessageId');
		expect(body).not.toHaveProperty('parentMessageId');
	});

	it('switches to retry shape when retryFromMessageId is set', () => {
		// Retry mode: server reuses the existing user message + adds
		// a new assistant sibling. text + attachedMediaIds are
		// deliberately dropped from the wire — they'd be ignored
		// server-side anyway, and including them is misleading.
		const body = buildSendRequestBody({
			...BASE,
			options: { retryFromMessageId: 'asst-789' },
		});
		expect(body).toEqual({
			regenerateFromMessageId: 'asst-789',
			modelId: 'bridge::gpt-image-1',
			modelKind: 'image',
		});
		expect(body).not.toHaveProperty('text');
		expect(body).not.toHaveProperty('attachedMediaIds');
	});

	it('retry shape ignores editedMessageId / parentMessageId even when present', () => {
		// Defensive: a future caller mixing retry with edit
		// shouldn't accidentally land both on the wire — the server's
		// retry path is distinct from the edit path. Retry wins.
		const body = buildSendRequestBody({
			...BASE,
			options: {
				retryFromMessageId: 'asst-789',
				editedMessageId: 'msg-edit',
				parentMessageId: 'msg-parent',
			},
		});
		expect(body.regenerateFromMessageId).toBe('asst-789');
		expect(body).not.toHaveProperty('editedMessageId');
		expect(body).not.toHaveProperty('parentMessageId');
	});

	it('passes modelKind through, including null', () => {
		// The chat page's modelKind state can legitimately be null
		// (e.g. an imported OWUI conversation with a model not in
		// config). The server tolerates this; the wire body just
		// needs to transmit faithfully.
		const body = buildSendRequestBody({
			...BASE,
			modelKind: null,
		});
		expect(body.modelKind).toBeNull();
	});

	it('preserves attachedMediaIds across the wire', () => {
		const body = buildSendRequestBody({
			...BASE,
			attachedMediaIds: ['m1', 'm2', 'm3'],
		});
		expect(body.attachedMediaIds).toEqual(['m1', 'm2', 'm3']);
	});
});

describe('buildFanoutBranchBody', () => {
	it('flags fanoutBranch, parents to the shared user message, and omits text', () => {
		const body = buildFanoutBranchBody({
			parentMessageId: 'user-1',
			modelId: 'bridge::claude',
			modelKind: 'chat',
		});
		expect(body).toEqual({
			fanoutBranch: true,
			parentMessageId: 'user-1',
			modelId: 'bridge::claude',
			modelKind: 'chat',
		});
		// text/attachments are intentionally absent — derived server-side from
		// the shared user message, like retry.
		expect(body).not.toHaveProperty('text');
		expect(body).not.toHaveProperty('attachedMediaIds');
	});

	it('carries modelKind through, including null', () => {
		const body = buildFanoutBranchBody({
			parentMessageId: 'user-1',
			modelId: 'bridge::x',
			modelKind: null,
		});
		expect(body.modelKind).toBeNull();
	});

	it('sends inputMediaIds for a split-attachments branch, omits it otherwise', () => {
		const split = buildFanoutBranchBody({
			parentMessageId: 'user-1',
			modelId: 'bridge::sdxl',
			modelKind: 'image',
			inputMediaId: 'img-3',
		});
		expect(split.inputMediaIds).toEqual(['img-3']);

		const noSplit = buildFanoutBranchBody({
			parentMessageId: 'user-1',
			modelId: 'bridge::sdxl',
			modelKind: 'image',
			inputMediaId: null,
		});
		expect(noSplit).not.toHaveProperty('inputMediaIds');
	});

	it('flags an additive re-roll branch, omits the flag otherwise', () => {
		const reroll = buildFanoutBranchBody({
			parentMessageId: 'user-1',
			modelId: 'bridge::sdxl',
			modelKind: 'image',
			reroll: true,
		});
		expect(reroll.reroll).toBe(true);

		const initial = buildFanoutBranchBody({
			parentMessageId: 'user-1',
			modelId: 'bridge::sdxl',
			modelKind: 'image',
		});
		expect(initial).not.toHaveProperty('reroll');
	});
});
