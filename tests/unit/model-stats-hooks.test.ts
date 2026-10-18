/**
 * Where the model-stats counters are attributed — the part that's easy to get
 * subtly wrong: a retry or edit counts against the reply it REPLACES, a branch
 * delete against the reply deleted (not everything after it), a conversation
 * clean-up as `swept` rather than a rejection, a comparison pick with no loss.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

vi.mock('#lib/server/endpoints/registry.js', () => ({
	getEndpoint: (id: string) => (id === 'gone' ? undefined : { id }),
}));

import {
	recordComparisonPick,
	recordEdit,
	recordModelSwitch,
	recordRetry,
} from '#lib/server/stats/reactions.js';
import { createConversation, deleteConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage, deleteBranch, getMessage } from '#lib/server/db/queries/messages.js';
import {
	insertMedia,
	linkMessageMedia,
	restoreMediaForUser,
	setMediaFavorite,
	bulkTrashMediaForUser,
} from '#lib/server/db/queries/media.js';
import { createUserMessage } from '#lib/server/messages/create-user-message.js';
import { modelStatsDaily } from '#lib/server/db/schema.js';
import type { MessagePart } from '#lib/types/api.js';

let db: TestDB;
let userId: string;
beforeEach(() => {
	db = createTestDb();
	userId = seedUser().id;
});
afterEach(() => closeTestDb());

/** `{ 'endpoint::model metric': count }`, summed across days. */
function tally(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const r of db.select().from(modelStatsDaily).all()) {
		const key = `${r.endpointId}::${r.modelId} ${r.metric}`;
		out[key] = (out[key] ?? 0) + r.count;
	}
	return out;
}

function conversation(modelId = 'local::qwen', modelKind: 'chat' | 'image' = 'chat') {
	return createConversation({
		userId,
		endpointId: modelId.split('::')[0],
		modelId,
		modelKind,
	});
}

function userTurn(conversationId: string, parentMessageId: string | null = null) {
	return appendMessage({
		conversationId,
		parentMessageId,
		role: 'user',
		parts: [{ type: 'text', text: 'q' }],
	});
}

function reply(
	conversationId: string,
	parentMessageId: string,
	modelUsed: string,
	opts: { finishReason?: string; parts?: MessagePart[]; advance?: boolean } = {},
) {
	return appendMessage({
		conversationId,
		parentMessageId,
		role: 'assistant',
		parts: opts.parts ?? [{ type: 'text', text: 'a' }],
		modelUsed,
		finishReason: opts.finishReason ?? 'stop',
		advanceActiveLeaf: opts.advance ?? true,
	});
}

function generatedImage(sourceModel = 'bridge::flux') {
	return insertMedia({
		userId,
		storagePath: `${Math.random()}.png`,
		contentType: 'image/png',
		byteSize: 1,
		kind: 'image',
		sourceEndpointId: sourceModel.split('::')[0],
		sourceModel,
		promptExcerpt: 'p',
	}).id;
}

describe('retry', () => {
	it('counts against the replaced reply, and flags one the user had stopped', () => {
		const c = conversation();
		const u = userTurn(c.id);
		recordRetry(reply(c.id, u.id, 'local::qwen'));
		recordRetry(reply(c.id, u.id, 'local::qwen', { finishReason: 'cancelled' }));
		expect(tally()).toEqual({ 'local::qwen retry': 2, 'local::qwen retry_after_cancel': 1 });
	});

	it('does not count retrying a failure — that was already an error', () => {
		const c = conversation();
		const u = userTurn(c.id);
		recordRetry(reply(c.id, u.id, 'local::qwen', { parts: [{ type: 'error', message: 'x' }] }));
		expect(tally()).toEqual({});
	});
});

describe('edit', () => {
	it("counts against the edited prompt's newest reply, flagging a stopped one", () => {
		const c = conversation();
		const u = userTurn(c.id);
		reply(c.id, u.id, 'local::old');
		reply(c.id, u.id, 'local::qwen', { finishReason: 'cancelled' });
		recordEdit(c.id, u.id);
		expect(tally()).toEqual({ 'local::qwen edit': 1, 'local::qwen edit_after_cancel': 1 });
	});

	it('counts nothing for a prompt that was never answered', () => {
		const c = conversation();
		recordEdit(c.id, userTurn(c.id).id);
		expect(tally()).toEqual({});
	});
});

describe('model switch', () => {
	it('counts chat → chat against the model left behind', () => {
		recordModelSwitch(
			{ modelId: 'local::qwen', kind: 'chat' },
			{ modelId: 'cloud::gpt', kind: 'chat' },
		);
		// A legacy row with no recorded kind is chat.
		recordModelSwitch(
			{ modelId: 'local::qwen', kind: null },
			{ modelId: 'cloud::gpt', kind: null },
		);
		expect(tally()).toEqual({ 'local::qwen switched_away': 2 });
	});

	it('ignores a change of medium and a dead imported route', () => {
		recordModelSwitch(
			{ modelId: 'local::qwen', kind: 'chat' },
			{ modelId: 'bridge::flux', kind: 'image' },
		);
		recordModelSwitch(
			{ modelId: 'bridge::flux', kind: 'image' },
			{ modelId: 'local::qwen', kind: 'chat' },
		);
		recordModelSwitch(
			{ modelId: 'gone::owui', kind: 'chat' },
			{ modelId: 'local::qwen', kind: 'chat' },
		);
		expect(tally()).toEqual({});
	});
});

describe('comparison pick', () => {
	it('shows every model once and credits only the winner — no losses', () => {
		const c = conversation();
		const u = userTurn(c.id);
		const a = reply(c.id, u.id, 'local::qwen', { advance: false });
		reply(c.id, u.id, 'cloud::gpt', { advance: false });
		reply(c.id, u.id, 'cloud::gpt', { advance: false });
		reply(c.id, u.id, 'cloud::bad', { advance: false, parts: [{ type: 'error', message: 'x' }] });

		recordComparisonPick(c.id, getMessage(c.id, a.id)!, 'fanout');
		expect(tally()).toEqual({
			'local::qwen fanout_shown': 1,
			'local::qwen fanout_win': 1,
			'cloud::gpt fanout_shown': 1,
		});
	});

	it('skips a comparison of one model against itself', () => {
		const c = conversation('bridge::flux', 'image');
		const u = userTurn(c.id);
		const a = reply(c.id, u.id, 'bridge::flux', { advance: false });
		reply(c.id, u.id, 'bridge::flux', { advance: false });
		recordComparisonPick(c.id, getMessage(c.id, a.id)!, 'avatar');
		expect(tally()).toEqual({});
	});
});

describe('deletes', () => {
	it('a branch delete rejects the deleted reply and its media, not the replies after it', () => {
		const c = conversation('bridge::flux', 'image');
		const u = userTurn(c.id);
		reply(c.id, u.id, 'bridge::sdxl');
		const img = generatedImage();
		const doomed = reply(c.id, u.id, 'bridge::flux', {
			parts: [{ type: 'image', mediaId: img }],
		});
		linkMessageMedia(doomed.id, img);
		const follow = userTurn(c.id, doomed.id);
		reply(c.id, follow.id, 'local::qwen');

		deleteBranch(c.id, doomed.id, userId);
		expect(tally()).toEqual({
			'bridge::flux branch_deleted': 1,
			'bridge::flux trashed': 1,
		});
	});

	it('a conversation delete with its media is a sweep, not a rejection', () => {
		const c = conversation('bridge::flux', 'image');
		const u = userTurn(c.id);
		const img = generatedImage();
		const r = reply(c.id, u.id, 'bridge::flux', { parts: [{ type: 'image', mediaId: img }] });
		linkMessageMedia(r.id, img);

		deleteConversation(c.id, userId, { deleteMedia: true });
		expect(tally()).toEqual({ 'bridge::flux swept': 1 });
	});

	it('restore counts back; the trash query itself counts nothing', () => {
		// The routes count `trashed`: the query is shared with the relay's
		// discard of a result the user never saw.
		const img = generatedImage();
		bulkTrashMediaForUser([img], userId);
		expect(tally()).toEqual({});
		restoreMediaForUser([img], userId);
		expect(tally()).toEqual({ 'bridge::flux restored': 1 });
	});
});

describe('favourites', () => {
	it('counts transitions, not repeated toggles', () => {
		const img = generatedImage();
		setMediaFavorite(img, userId, true);
		setMediaFavorite(img, userId, true);
		setMediaFavorite(img, userId, false);
		setMediaFavorite(img, userId, false);
		expect(tally()).toEqual({ 'bridge::flux favorited': 1, 'bridge::flux unfavorited': 1 });
	});
});

describe('remix', () => {
	it('counts a generated output attached to a new prompt, but not an upload', () => {
		const c = conversation('bridge::flux', 'image');
		const img = generatedImage();
		const upload = insertMedia({
			userId,
			storagePath: 'photo.png',
			contentType: 'image/png',
			byteSize: 1,
			kind: 'image',
			origin: 'uploaded',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
		}).id;
		createUserMessage({
			conversationId: c.id,
			userId,
			text: 'make it blue',
			attachedMediaIds: [img, upload],
			activeLeafMessageId: null,
			existingTitle: 'T',
		});
		expect(tally()).toEqual({ 'bridge::flux remixed': 1 });
	});

	it('does not recount what an edited prompt already carried', () => {
		const c = conversation('bridge::flux', 'image');
		const img = generatedImage();
		const first = createUserMessage({
			conversationId: c.id,
			userId,
			text: 'make it blue',
			attachedMediaIds: [img],
			activeLeafMessageId: null,
			existingTitle: 'T',
		});
		createUserMessage({
			conversationId: c.id,
			userId,
			text: 'make it red',
			attachedMediaIds: [img],
			editedMessageId: first.id,
			activeLeafMessageId: first.id,
			existingTitle: 'T',
		});
		expect(tally()).toEqual({ 'bridge::flux remixed': 1 });
	});
});
