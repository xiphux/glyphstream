/**
 * Tests for migration 0006 — best-effort prompt recovery from the
 * user message that triggered each generation.
 *
 * The migration's SQL is read straight from the .sql file so this
 * test stays in sync with whatever ships: if a future edit to the
 * recovery query introduces a regression we'll see it here instead
 * of discovering it in prod via "Regenerate" silently using the
 * truncated excerpt for a row whose conversation was right there
 * the whole time.
 *
 * Test setup note: `createTestDb()` already runs all migrations
 * (including 0006) against the in-memory DB at construction time.
 * That run is a no-op because there's no data yet. To exercise the
 * recovery against representative data we seed legacy-shaped rows
 * (prompt_full equal to prompt_excerpt, simulating the post-0005
 * fallback state) and then re-execute the migration's SQL by hand.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import { appendMessage, setActiveLeafMessageId } from '$lib/server/db/queries/messages';
import { createConversation } from '$lib/server/db/queries/conversations';
import { insertMedia, linkMessageMedia } from '$lib/server/db/queries/media';
import { media } from '$lib/server/db/schema';

// drizzle v1 stores each migration as `<timestamp>_<name>/migration.sql`
// rather than the old flat `NNNN_<name>.sql`. Resolve by name suffix so the
// test survives any future `drizzle-kit up` re-timestamping.
const recoverDir = readdirSync(resolve('./drizzle')).find((d) => d.endsWith('_recover_prompts'));
if (!recoverDir) throw new Error('recover_prompts migration directory not found');
const RECOVERY_SQL = readFileSync(resolve(`./drizzle/${recoverDir}/migration.sql`), 'utf-8');

function runRecovery() {
	mocks.testDb.run(sql.raw(RECOVERY_SQL));
}

function getRow(mediaId: string) {
	return mocks.testDb.select().from(media).where(eq(media.id, mediaId)).get();
}

const LONG_PROMPT =
	'A photorealistic portrait of a red panda playing piano in a detailed ' +
	'art-deco style, dramatic lighting, intricate fur texture, bokeh ' +
	'background, render in 8k with cinematic depth of field and an ' +
	'overall warm color palette, paying close attention to small details ' +
	'in the keys, the panda`s paws, and the velvet curtains behind it';

const EXCERPT_FALLBACK = LONG_PROMPT.slice(0, 499) + '…';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('migration 0006: prompt recovery', () => {
	it('rehydrates promptFull from the parent user message when available', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const userMsg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: LONG_PROMPT }],
		});
		const assistantMsg = appendMessage({
			conversationId: conv.id,
			parentMessageId: userMsg.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'here you go' }],
		});
		setActiveLeafMessageId(conv.id, assistantMsg.id);
		// Seed legacy state: persister wrote the excerpt, 0005's backfill
		// copied it into promptFull. promptFull currently equals the
		// truncated value.
		const { id: mediaId } = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/legacy.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::image',
			promptExcerpt: EXCERPT_FALLBACK,
			promptFull: EXCERPT_FALLBACK,
		});
		linkMessageMedia(assistantMsg.id, mediaId);

		runRecovery();

		const row = getRow(mediaId);
		// Recovered the full text from the user message — promptFull is
		// now the real, untruncated prompt.
		expect(row?.promptFull).toBe(LONG_PROMPT);
		// Excerpt stays as it was — only promptFull is rehydrated.
		expect(row?.promptExcerpt).toBe(EXCERPT_FALLBACK);
	});

	it('finds the first text part even when the user message leads with an image', () => {
		// Image-edit flow: user attaches an image first, then types
		// "edit this". The recovery has to skip past the image part to
		// find the text — driven by json_each + type='text' filter.
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const sourceImage = insertMedia({
			userId: u.id,
			storagePath: 'aa/bb/source.png',
			contentType: 'image/png',
			byteSize: 512,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
			origin: 'uploaded',
		});
		const editPrompt = 'remove the background and make the panda blue';
		const userMsg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [
				{ type: 'image', mediaId: sourceImage.id },
				{ type: 'text', text: editPrompt },
			],
		});
		const assistantMsg = appendMessage({
			conversationId: conv.id,
			parentMessageId: userMsg.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'done' }],
		});
		setActiveLeafMessageId(conv.id, assistantMsg.id);
		const { id: mediaId } = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/edited.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::image',
			promptExcerpt: editPrompt,
			promptFull: editPrompt, // already short, but same fallback signature
		});
		linkMessageMedia(assistantMsg.id, mediaId);

		runRecovery();

		expect(getRow(mediaId)?.promptFull).toBe(editPrompt);
	});

	it('picks the earliest assistant link when media spans multiple conversations', () => {
		// Auto-attach flow: image generated in conv A, then re-used as
		// input in conv B via the auto-attach-last-generated path. The
		// media is linked from BOTH assistant messages. Recovery should
		// pick conv A's user message (the one that *originally generated*
		// the image), not conv B's (which is a follow-up using the image
		// as input).
		const u = seedUser();
		const earlyPrompt = 'original prompt that generated this image';
		const lateFollowUpPrompt = 'now make it red';

		const convA = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const userA = appendMessage({
			conversationId: convA.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: earlyPrompt }],
		});
		const assistantA = appendMessage({
			conversationId: convA.id,
			parentMessageId: userA.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'made it' }],
		});
		setActiveLeafMessageId(convA.id, assistantA.id);

		const { id: mediaId } = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/multi.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::image',
			promptExcerpt: 'something',
			promptFull: 'something',
		});
		linkMessageMedia(assistantA.id, mediaId);

		// Then a later conversation re-uses the same image as input.
		const convB = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const userB = appendMessage({
			conversationId: convB.id,
			parentMessageId: null,
			role: 'user',
			parts: [
				{ type: 'image', mediaId },
				{ type: 'text', text: lateFollowUpPrompt },
			],
		});
		const assistantB = appendMessage({
			conversationId: convB.id,
			parentMessageId: userB.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'tweaked' }],
		});
		setActiveLeafMessageId(convB.id, assistantB.id);
		linkMessageMedia(assistantB.id, mediaId);

		runRecovery();

		expect(getRow(mediaId)?.promptFull).toBe(earlyPrompt);
	});

	it('leaves promptFull alone when it already differs from the excerpt', () => {
		// Row inserted post-0005 by the new persister — promptFull holds
		// the real full prompt that's longer than the excerpt. Recovery
		// should not touch it.
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const userMsg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'a different prompt entirely' }],
		});
		const assistantMsg = appendMessage({
			conversationId: conv.id,
			parentMessageId: userMsg.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'ok' }],
		});
		setActiveLeafMessageId(conv.id, assistantMsg.id);
		const PRESERVED_FULL = 'real full prompt with all the details intact';
		const { id: mediaId } = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/preserved.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::image',
			promptExcerpt: 'real full prompt with…', // different from full
			promptFull: PRESERVED_FULL,
		});
		linkMessageMedia(assistantMsg.id, mediaId);

		runRecovery();

		// Untouched — the WHERE eligibility filter excluded it.
		expect(getRow(mediaId)?.promptFull).toBe(PRESERVED_FULL);
	});

	it('keeps the excerpt fallback when the source conversation was already deleted', () => {
		// Legacy media whose linking conversation is gone (e.g. deleted
		// during the pre-library-model 7-day-purger era). No assistant
		// message to walk back from. The COALESCE chain preserves the
		// current value (which is the 0005 excerpt fallback) — we don't
		// regress to NULL.
		const u = seedUser();
		const { id: mediaId } = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/orphan.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::image',
			promptExcerpt: EXCERPT_FALLBACK,
			promptFull: EXCERPT_FALLBACK,
		});
		// No linkMessageMedia call — this media is unlinked, mimicking
		// "the conversation that generated me was deleted long ago".

		runRecovery();

		// Falls through COALESCE to keep the existing value.
		expect(getRow(mediaId)?.promptFull).toBe(EXCERPT_FALLBACK);
	});

	it('skips uploaded media entirely', () => {
		// Uploads never had a generation prompt; they shouldn't be touched
		// even if they happen to have a populated promptExcerpt for some
		// odd reason.
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const userMsg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'unrelated text' }],
		});
		setActiveLeafMessageId(conv.id, userMsg.id);
		const { id: mediaId } = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/upload.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
			promptFull: null,
			origin: 'uploaded',
		});
		linkMessageMedia(userMsg.id, mediaId);

		runRecovery();

		// Origin filter in the outer WHERE skips this row.
		expect(getRow(mediaId)?.promptFull).toBeNull();
	});
});
