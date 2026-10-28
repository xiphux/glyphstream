/**
 * The migration that moves avatar portraits off the thread and onto the reply
 * they were drawn from (`*_portraits_onto_replies`). Seeds the shapes the old
 * design left in the database — a portrait is a display-only image message
 * under the description reply — then runs the migration's SQL by hand
 * (createTestDb already ran it, against nothing) and checks what each became.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { appendMessage, setActiveLeafMessageId } from '#lib/server/db/queries/messages.js';
import {
	createConversation,
	setConversationAvatar,
	setFanoutParent,
} from '#lib/server/db/queries/conversations.js';
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

const dir = readdirSync(resolve('./drizzle')).find((d) => d.endsWith('_portraits_onto_replies'));
if (!dir) throw new Error('portraits_onto_replies migration directory not found');
const STATEMENTS = readFileSync(resolve(`./drizzle/${dir}/migration.sql`), 'utf-8')
	.split('--> statement-breakpoint')
	.map((s) => s.trim())
	.filter(Boolean);

let db: TestDB;
let userId: string;
let convId: string;
let descriptionId: string;

function migrate() {
	for (const statement of STATEMENTS) db.run(sql.raw(statement));
}

function add(parentMessageId: string | null, role: 'user' | 'assistant', parts: MessagePart[]) {
	return appendMessage({ conversationId: convId, parentMessageId, role, parts }).id;
}

let seq = 0;
function image(modelUsed: string) {
	return insertMedia({
		userId,
		storagePath: `generated/a${++seq}.png`,
		contentType: 'image/png',
		byteSize: 1,
		kind: 'image',
		sourceEndpointId: 'ep',
		sourceModel: modelUsed,
		promptExcerpt: 'x',
	}).id;
}

/** Distinct times, in creation order, so versions sort deterministically. */
function stamp(id: string) {
	db.update(messages)
		.set({ createdAt: Date.now() + ++seq })
		.where(eq(messages.id, id))
		.run();
}

/** An old-style portrait message: its own row under the description, linked
 *  to its image. */
function portrait(modelUsed = 'ep::sdxl', parentId = descriptionId) {
	const mediaId = image(modelUsed);
	const id = appendMessage({
		conversationId: convId,
		parentMessageId: parentId,
		role: 'assistant',
		parts: [{ type: 'image', mediaId, displayOnly: true } as unknown as MessagePart],
		modelUsed,
	}).id;
	linkMessageMedia(id, mediaId);
	stamp(id);
	return { id, mediaId };
}

function failedDraw() {
	const id = appendMessage({
		conversationId: convId,
		parentMessageId: descriptionId,
		role: 'assistant',
		parts: [{ type: 'error', message: 'out of memory' } as MessagePart],
		modelUsed: 'ep::sdxl',
	}).id;
	stamp(id);
	return id;
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
	}).id;
	const user = add(null, 'user', text('describe yourself'));
	descriptionId = add(user, 'assistant', text('<description>a fox</description>'));
	stamp(descriptionId);
});
afterEach(() => closeTestDb());

describe('portraits onto replies', () => {
	it('turns portraits into versions on the description, the face on show', () => {
		const first = portrait('ep::sdxl');
		const face = portrait('ep::flux');
		const u2 = add(face.id, 'user', text('love it'));
		const a2 = add(u2, 'assistant', text('thanks'));
		setActiveLeafMessageId(convId, a2);
		setConversationAvatar(convId, userId, face.mediaId);

		migrate();

		expect(ids()).not.toContain(first.id);
		expect(ids()).not.toContain(face.id);
		// The conversation carries on straight from the description.
		expect(parentOf(u2)).toBe(descriptionId);
		expect(conv().activeLeafMessageId).toBe(a2);
		expect(versions()).toMatchObject([
			{
				messageId: descriptionId,
				kind: 'portrait',
				markerIndex: null,
				mediaId: first.mediaId,
				modelId: 'ep::sdxl',
				shownAt: null,
			},
			{
				messageId: descriptionId,
				kind: 'portrait',
				markerIndex: null,
				mediaId: face.mediaId,
				modelId: 'ep::flux',
			},
		]);
		expect(versions()[1].shownAt).not.toBeNull();
		// The images now belong to the description; the face keeps its own ref.
		expect(links(face.mediaId)).toEqual([descriptionId]);
		expect(refCount(first.mediaId)).toBe(1);
		expect(refCount(face.mediaId)).toBe(2);
		expect(conv().avatarMediaId).toBe(face.mediaId);
	});

	it('shows the newest where the face is none of them', () => {
		portrait('ep::sdxl');
		const newest = portrait('ep::flux');

		migrate();

		expect(versions().map((v) => v.shownAt !== null)).toEqual([false, true]);
		expect(versions()[1].mediaId).toBe(newest.mediaId);
	});

	it('drops failed draws, and moves a leaf that was on one to the description', () => {
		portrait();
		const failed = failedDraw();
		setActiveLeafMessageId(convId, failed);

		migrate();

		expect(ids()).not.toContain(failed);
		expect(conv().activeLeafMessageId).toBe(descriptionId);
		expect(versions()).toHaveLength(1);
	});

	it('moves a leaf on a portrait to its description', () => {
		const p = portrait();
		setActiveLeafMessageId(convId, p.id);

		migrate();

		expect(conv().activeLeafMessageId).toBe(descriptionId);
	});

	it('ends an open avatar comparison, keeping its portraits and the face', () => {
		const face = portrait();
		setConversationAvatar(convId, userId, face.mediaId);
		portrait('ep::flux');
		portrait('ep::dalle');
		setFanoutParent(convId, userId, descriptionId);
		setActiveLeafMessageId(convId, descriptionId);

		migrate();

		expect(conv().fanoutParentMessageId).toBeNull();
		expect(conv().avatarMediaId).toBe(face.mediaId);
		expect(versions()).toHaveLength(3);
		expect(
			versions()
				.filter((v) => v.shownAt !== null)
				.map((v) => v.mediaId),
		).toEqual([face.mediaId]);
	});

	it('leaves a turn fan-out parked on the user message alone', () => {
		const user = add(descriptionId, 'user', text('compare these'));
		setFanoutParent(convId, userId, user);
		setActiveLeafMessageId(convId, user);

		migrate();

		expect(conv().fanoutParentMessageId).toBe(user);
	});

	it('lands queued draws as portraits, a comparison’s still comparing', () => {
		const params = JSON.stringify({
			prompt: 'a fox',
			dispatchMediaIds: [],
			sourceMediaId: null,
			enhancementEnabled: false,
			promptStyle: null,
			promptHint: null,
			displayOnly: true,
		});
		const job = (id: string, origin: string) => {
			insertGenerationJob({
				id,
				userId,
				conversationId: convId,
				anchorMessageId: descriptionId,
				kind: 'image',
				origin: 'portrait',
				modelId: 'ep::sdxl',
				fanoutIndex: origin === 'avatar_fanout' ? 2 : null,
				paramsJson: params,
				createdAt: 1,
			});
			// Written by the release before this one, whose origins are gone now.
			db.run(sql`UPDATE generation_jobs SET origin = ${origin} WHERE id = ${id}`);
		};
		job('single', 'avatar');
		job('branch', 'avatar_fanout');

		migrate();

		const rows = db
			.select()
			.from(generationJobs)
			.all()
			.sort((a, b) => a.id.localeCompare(b.id));
		expect(rows.map((r) => [r.id, r.origin, r.anchorMessageId, r.fanoutIndex])).toEqual([
			['branch', 'portrait', descriptionId, null],
			['single', 'portrait', descriptionId, null],
		]);
		expect((JSON.parse(rows[0].paramsJson) as { compareId?: string }).compareId).toBe(
			`migrated-${descriptionId}`,
		);
		expect((JSON.parse(rows[1].paramsJson) as { compareId?: string }).compareId).toBeUndefined();
	});

	it('leaves an image an image model replied with alone', () => {
		const user = add(descriptionId, 'user', text('draw a cat'));
		const mediaId = image('ep::sdxl');
		const reply = appendMessage({
			conversationId: convId,
			parentMessageId: user,
			role: 'assistant',
			parts: [{ type: 'image', mediaId } as MessagePart],
		}).id;

		migrate();

		expect(ids()).toContain(reply);
		expect(versions()).toHaveLength(0);
	});

	it('is a no-op on a database with no portraits', () => {
		const before = ids();

		migrate();

		expect(ids()).toEqual(before);
		expect(versions()).toHaveLength(0);
	});
});
