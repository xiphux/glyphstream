/**
 * The migration that moves texting photos off the thread and onto the reply
 * that sent them (`*_photos_onto_replies`). Seeds the shapes the old design
 * left in the database — a photo is an assistant message whose image part is
 * stamped with the marker it developed — then runs the migration's SQL by hand
 * (createTestDb already ran it, against nothing) and checks what each became.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { appendMessage, setActiveLeafMessageId } from '#lib/server/db/queries/messages.js';
import { createConversation, setFanoutParent } from '#lib/server/db/queries/conversations.js';
import { insertMedia, linkMessageMedia } from '#lib/server/db/queries/media.js';
import { insertGenerationJob } from '#lib/server/db/queries/generation-jobs.js';
import {
	conversations,
	generationJobs,
	media,
	messageImages,
	messageMedia,
	messages,
} from '#lib/server/db/schema.js';
import type { MessagePart } from '#lib/types/api.js';

const dir = readdirSync(resolve('./drizzle')).find((d) => d.endsWith('_photos_onto_replies'));
if (!dir) throw new Error('photos_onto_replies migration directory not found');
const STATEMENTS = readFileSync(resolve(`./drizzle/${dir}/migration.sql`), 'utf-8')
	.split('--> statement-breakpoint')
	.map((s) => s.trim())
	.filter(Boolean);

let db: TestDB;
let userId: string;
let convId: string;
let replyId: string;

function migrate() {
	for (const statement of STATEMENTS) db.run(sql.raw(statement));
}

function add(parentMessageId: string | null, role: 'user' | 'assistant', parts: MessagePart[]) {
	return appendMessage({ conversationId: convId, parentMessageId, role, parts }).id;
}

let mediaSeq = 0;
/** An old-style photo message: its own row, under `parentId`, linked to its image. */
function photo(parentId: string, index: number, modelUsed = 'ep::sdxl') {
	const mediaId = insertMedia({
		userId,
		storagePath: `generated/p${++mediaSeq}.png`,
		contentType: 'image/png',
		byteSize: 1,
		kind: 'image',
		sourceEndpointId: 'ep',
		sourceModel: modelUsed,
		promptExcerpt: 'x',
	}).id;
	const id = appendMessage({
		conversationId: convId,
		parentMessageId: parentId,
		role: 'assistant',
		parts: [
			{
				type: 'image',
				mediaId,
				displayOnly: true,
				photo: { sourceMessageId: replyId, index },
			} as unknown as MessagePart,
		],
		modelUsed,
	}).id;
	linkMessageMedia(id, mediaId);
	return { id, mediaId };
}

const text = (t: string): MessagePart[] => [{ type: 'text', text: t }];
const ids = () =>
	db
		.select({ id: messages.id })
		.from(messages)
		.where(eq(messages.conversationId, convId))
		.all()
		.map((r) => r.id);
const parentOf = (id: string) =>
	db.select().from(messages).where(eq(messages.id, id)).get()?.parentMessageId;
const conv = () => db.select().from(conversations).where(eq(conversations.id, convId)).get()!;
const versions = () =>
	db
		.select()
		.from(messageImages)
		.all()
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
const links = (mediaId: string) =>
	db
		.select({ messageId: messageMedia.messageId })
		.from(messageMedia)
		.where(eq(messageMedia.mediaId, mediaId))
		.all()
		.map((r) => r.messageId);
const refCount = (mediaId: string) =>
	db.select().from(media).where(eq(media.id, mediaId)).get()!.refCount;

beforeEach(() => {
	db = createTestDb();
	userId = seedUser().id;
	convId = createConversation({
		userId,
		endpointId: 'ep',
		modelId: 'ep::chat',
		modelKind: 'chat',
		replyStyle: 'texting',
	}).id;
	const user = add(null, 'user', text('send pics'));
	replyId = add(user, 'assistant', text('ok\n\n[photo: one]\n\n[photo: two]'));
});
afterEach(() => closeTestDb());

describe('photos onto replies', () => {
	it('turns a chain of photos into versions on the reply, and closes the gap', () => {
		const p0 = photo(replyId, 0);
		const p1 = photo(p0.id, 1, 'ep::flux');
		const u2 = add(p1.id, 'user', text('cute'));
		const a2 = add(u2, 'assistant', text('ty'));
		setActiveLeafMessageId(convId, a2);

		migrate();

		expect(ids()).not.toContain(p0.id);
		expect(ids()).not.toContain(p1.id);
		// The conversation carries on straight from the reply.
		expect(parentOf(u2)).toBe(replyId);
		expect(conv().activeLeafMessageId).toBe(a2);
		expect(versions()).toMatchObject([
			{
				messageId: replyId,
				kind: 'photo',
				markerIndex: 0,
				mediaId: p0.mediaId,
				modelId: 'ep::sdxl',
			},
			{
				messageId: replyId,
				kind: 'photo',
				markerIndex: 1,
				mediaId: p1.mediaId,
				modelId: 'ep::flux',
			},
		]);
		// Both were on the branch, so both are on show.
		expect(versions().every((v) => v.shownAt !== null)).toBe(true);
		// The images now belong to the reply, counted once each.
		expect(links(p0.mediaId)).toEqual([replyId]);
		expect(refCount(p0.mediaId)).toBe(1);
		expect(refCount(p1.mediaId)).toBe(1);
	});

	it('keeps the reference a photo holds as an avatar', () => {
		const p0 = photo(replyId, 0);
		// Set as the conversation's face: one more reference than its message link.
		db.update(media).set({ refCount: 2 }).where(eq(media.id, p0.mediaId)).run();

		migrate();

		expect(links(p0.mediaId)).toEqual([replyId]);
		expect(refCount(p0.mediaId)).toBe(2);
	});

	it('keeps every version of a re-developed photo, with the one on the branch on show', () => {
		const first = photo(replyId, 0);
		const again = photo(replyId, 0, 'ep::flux');
		setActiveLeafMessageId(convId, again.id);

		migrate();

		const [a, b] = versions();
		expect([a.mediaId, b.mediaId]).toEqual([first.mediaId, again.mediaId]);
		expect(a.shownAt).toBeNull();
		expect(b.shownAt).not.toBeNull();
		expect(conv().activeLeafMessageId).toBe(replyId);
	});

	it('puts the newest version on show where none was on the branch', () => {
		const first = photo(replyId, 0);
		const again = photo(replyId, 0, 'ep::flux');
		const other = add(replyId, 'user', text('a different reply'));
		setActiveLeafMessageId(convId, other);

		migrate();

		const shown = versions().filter((v) => v.shownAt !== null);
		expect(shown.map((v) => v.mediaId)).toEqual([again.mediaId]);
		expect(versions().find((v) => v.mediaId === first.mediaId)?.shownAt).toBeNull();
	});

	it('drops a failed draw beside the photos, and the leaf it held', () => {
		photo(replyId, 0);
		const failed = add(replyId, 'assistant', [{ type: 'error', message: 'out of memory' }]);
		setActiveLeafMessageId(convId, failed);

		migrate();

		expect(ids()).not.toContain(failed);
		expect(conv().activeLeafMessageId).toBe(replyId);
	});

	it('ends an open comparison, keeping its candidates as versions', () => {
		photo(replyId, 1);
		photo(replyId, 1, 'ep::flux');
		setFanoutParent(convId, userId, replyId, true);

		migrate();

		expect(conv().fanoutParentMessageId).toBeNull();
		expect(conv().activeLeafMessageId).toBe(replyId);
		expect(versions()).toHaveLength(2);
	});

	it('ends a comparison open before any of its draws landed', () => {
		setFanoutParent(convId, userId, replyId, true);
		insertGenerationJob({
			id: 'branch',
			userId,
			conversationId: convId,
			anchorMessageId: replyId,
			kind: 'image',
			origin: 'avatar_fanout',
			modelId: 'ep::sdxl',
			fanoutIndex: 0,
			paramsJson: JSON.stringify({ photo: { sourceMessageId: replyId, index: 0 } }),
			createdAt: 1,
		});

		migrate();

		expect(conv().fanoutParentMessageId).toBeNull();
	});

	it('leaves an avatar comparison parked', () => {
		setFanoutParent(convId, userId, replyId, true);
		insertGenerationJob({
			id: 'portrait',
			userId,
			conversationId: convId,
			anchorMessageId: replyId,
			kind: 'image',
			origin: 'avatar_fanout',
			modelId: 'ep::sdxl',
			fanoutIndex: 0,
			paramsJson: JSON.stringify({ prompt: 'a fox' }),
			createdAt: 1,
		});

		migrate();

		expect(conv().fanoutParentMessageId).toBe(replyId);
	});

	it('leaves an avatar comparison open on a reply that also has a photo', () => {
		photo(replyId, 0);
		const mediaId = insertMedia({
			userId,
			storagePath: 'generated/portrait.png',
			contentType: 'image/png',
			byteSize: 1,
			kind: 'image',
			sourceEndpointId: 'ep',
			sourceModel: 'ep::sdxl',
			promptExcerpt: 'x',
		}).id;
		add(replyId, 'assistant', [{ type: 'image', mediaId, displayOnly: true }]);
		setFanoutParent(convId, userId, replyId, true);

		migrate();

		expect(conv().fanoutParentMessageId).toBe(replyId);
	});

	it('lands queued draws of a photo on its reply', () => {
		const p0 = photo(replyId, 0);
		const params = (index: number) =>
			JSON.stringify({
				prompt: 'x',
				dispatchMediaIds: [],
				sourceMediaId: null,
				enhancementEnabled: false,
				promptStyle: null,
				promptHint: null,
				displayOnly: true,
				photo: { sourceMessageId: replyId, index },
			});
		const job = (id: string, origin: 'photo' | 'avatar_fanout', anchor: string, index: number) =>
			insertGenerationJob({
				id,
				userId,
				conversationId: convId,
				anchorMessageId: anchor,
				kind: 'image',
				origin,
				modelId: 'ep::sdxl',
				fanoutIndex: origin === 'avatar_fanout' ? 3 : null,
				paramsJson: params(index),
				createdAt: 1,
			});
		// The next photo of a chain hung under the last one; a comparison's under
		// the reply.
		job('next', 'photo', p0.id, 1);
		job('branch', 'avatar_fanout', replyId, 0);

		migrate();

		expect(
			db
				.select({
					id: generationJobs.id,
					origin: generationJobs.origin,
					anchor: generationJobs.anchorMessageId,
					fanoutIndex: generationJobs.fanoutIndex,
				})
				.from(generationJobs)
				.all()
				.sort((a, b) => a.id.localeCompare(b.id)),
		).toEqual([
			{ id: 'branch', origin: 'photo', anchor: replyId, fanoutIndex: null },
			{ id: 'next', origin: 'photo', anchor: replyId, fanoutIndex: null },
		]);
	});

	it('leaves an avatar portrait, which is no photo, where it is', () => {
		const mediaId = insertMedia({
			userId,
			storagePath: 'generated/portrait.png',
			contentType: 'image/png',
			byteSize: 1,
			kind: 'image',
			sourceEndpointId: 'ep',
			sourceModel: 'ep::sdxl',
			promptExcerpt: 'x',
		}).id;
		const portrait = add(replyId, 'assistant', [{ type: 'image', mediaId, displayOnly: true }]);
		const failed = add(replyId, 'assistant', [{ type: 'error', message: 'boom' }]);

		migrate();

		expect(ids()).toContain(portrait);
		// No photo beside it, so nothing marks it as a photo's failed draw.
		expect(ids()).toContain(failed);
		expect(versions()).toEqual([]);
	});

	it('does nothing to a database with no photos', () => {
		const before = ids();
		migrate();
		expect(ids()).toEqual(before);
		expect(versions()).toEqual([]);
	});
});
