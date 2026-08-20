/**
 * Avatar lifetime — the part of custom-model avatars that fails silently and
 * destructively if it's wrong.
 *
 * `media.ref_count` was built for `message_media`, and the purger's candidate
 * query can only see referrers of that shape. An avatar is a referrer of a
 * different shape, so these tests pin the thing that makes it participate:
 * setting one takes a reference, clearing/replacing/deleting releases exactly
 * one, and a purge sweep leaves a referenced upload alone. Without the
 * reference an uploaded avatar is reaped 30 minutes after it's chosen, which
 * looks like nothing at all until the image quietly stops loading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	createCustomModel,
	deleteCustomModel,
	getCustomModelForUser,
	setCustomModelAvatar,
} from '$lib/server/db/queries/custom-models';
import {
	countOrphanMediaInConversation,
	findPurgeCandidates,
	insertMedia,
	linkMessageMedia,
} from '$lib/server/db/queries/media';
import {
	createConversation,
	deleteConversation,
	setConversationAvatar,
} from '$lib/server/db/queries/conversations';
import { appendMessage } from '$lib/server/db/queries/messages';
import { media } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

function makeUpload(userId: string) {
	// origin 'uploaded' is the case that matters: generated media is never
	// auto-purged, so only an upload can be silently reaped out from under a
	// preset. Mirrors /api/uploads — ref_count 0, unreferenced clock already
	// running.
	const { id } = insertMedia({
		userId,
		storagePath: `ab/cd/${Math.random().toString(36).slice(2)}.png`,
		contentType: 'image/png',
		byteSize: 1024,
		kind: 'image',
		origin: 'uploaded',
		sourceEndpointId: null,
		sourceModel: null,
		promptExcerpt: null,
	});
	mocks.testDb.update(media).set({ unreferencedSince: Date.now() }).where(eq(media.id, id)).run();
	return id;
}

function mediaRow(id: string) {
	return mocks.testDb.select().from(media).where(eq(media.id, id)).get();
}

function makePreset(userId: string) {
	return createCustomModel({
		userId,
		name: 'Ilya',
		description: null,
		baseEndpointId: 'bridge',
		baseModelId: 'gpt-4o',
		systemPrompt: 'You are Ilya.',
		parameters: null,
	});
}

describe('custom-model avatars — reference lifetime', () => {
	it('setting an avatar takes a reference and stops the purge clock', () => {
		const u = seedUser();
		const cm = makePreset(u.id);
		const m = makeUpload(u.id);

		const r = setCustomModelAvatar(cm.id, u.id, m);
		expect(r.ok).toBe(true);
		expect(mediaRow(m)).toMatchObject({ refCount: 1, unreferencedSince: null });
	});

	it('a referenced upload survives a purge sweep that would otherwise reap it', () => {
		const u = seedUser();
		const cm = makePreset(u.id);
		const referenced = makeUpload(u.id);
		const abandoned = makeUpload(u.id);
		setCustomModelAvatar(cm.id, u.id, referenced);

		// Everything unreferenced as of now is due; only the abandoned one is.
		const due = findPurgeCandidates(Date.now() + 1).map((c) => c.id);
		expect(due).toContain(abandoned);
		expect(due).not.toContain(referenced);
	});

	it('replacing an avatar moves the reference rather than accumulating one', () => {
		const u = seedUser();
		const cm = makePreset(u.id);
		const first = makeUpload(u.id);
		const second = makeUpload(u.id);

		setCustomModelAvatar(cm.id, u.id, first);
		setCustomModelAvatar(cm.id, u.id, second);

		expect(mediaRow(first)?.refCount).toBe(0);
		expect(mediaRow(second)?.refCount).toBe(1);
		// The displaced one re-enters the grace-period clock, so it's reapable
		// again — it isn't stranded at zero refs with no expiry stamp.
		expect(mediaRow(first)?.unreferencedSince).not.toBeNull();
		expect(getCustomModelForUser(cm.id, u.id)?.avatarMediaId).toBe(second);
	});

	it('re-setting the SAME avatar does not double-count the reference', () => {
		// The helpers have no join-table PK to absorb a repeat, so idempotence
		// has to come from the equality check. A double-bump would pin the media
		// forever: nothing ever decrements it back to zero.
		const u = seedUser();
		const cm = makePreset(u.id);
		const m = makeUpload(u.id);

		setCustomModelAvatar(cm.id, u.id, m);
		setCustomModelAvatar(cm.id, u.id, m);

		expect(mediaRow(m)?.refCount).toBe(1);
	});

	it('clearing an avatar releases the reference', () => {
		const u = seedUser();
		const cm = makePreset(u.id);
		const m = makeUpload(u.id);

		setCustomModelAvatar(cm.id, u.id, m);
		const r = setCustomModelAvatar(cm.id, u.id, null);

		expect(r.ok).toBe(true);
		expect(mediaRow(m)).toMatchObject({ refCount: 0 });
		expect(getCustomModelForUser(cm.id, u.id)?.avatarMediaId).toBeNull();
	});

	it('deleting the preset releases its avatar', () => {
		const u = seedUser();
		const cm = makePreset(u.id);
		const m = makeUpload(u.id);
		setCustomModelAvatar(cm.id, u.id, m);

		expect(deleteCustomModel(cm.id, u.id)).toBe(true);
		expect(mediaRow(m)?.refCount).toBe(0);
		// And it's collectable again — otherwise the bytes outlive every referrer.
		expect(findPurgeCandidates(Date.now() + 1).map((c) => c.id)).toContain(m);
	});
});

describe('custom-model avatars — ownership', () => {
	it("refuses another user's media without touching either row", () => {
		const owner = seedUser();
		const other = seedUser();
		const cm = makePreset(owner.id);
		const theirs = makeUpload(other.id);

		const r = setCustomModelAvatar(cm.id, owner.id, theirs);

		expect(r).toEqual({ ok: false, reason: 'media_not_found' });
		expect(mediaRow(theirs)?.refCount).toBe(0);
		expect(getCustomModelForUser(cm.id, owner.id)?.avatarMediaId).toBeNull();
	});

	it('refuses a preset belonging to someone else', () => {
		const owner = seedUser();
		const other = seedUser();
		const cm = makePreset(owner.id);
		const m = makeUpload(other.id);

		expect(setCustomModelAvatar(cm.id, other.id, m)).toEqual({
			ok: false,
			reason: 'not_found',
		});
	});

	it('refuses a tombstoned media row', () => {
		// The gallery can hard-delete an image; the row survives as a tombstone
		// with its bytes gone, so adopting one would render a permanent 404.
		const u = seedUser();
		const cm = makePreset(u.id);
		const m = makeUpload(u.id);
		mocks.testDb.update(media).set({ hardDeletedAt: Date.now() }).where(eq(media.id, m)).run();

		expect(setCustomModelAvatar(cm.id, u.id, m)).toEqual({
			ok: false,
			reason: 'media_not_found',
		});
	});
});

describe('custom-model avatars — interaction with the orphan analysis', () => {
	it("keeps a conversation's generated image off the orphan list while it is an avatar", () => {
		// The delete-conversation dialog offers to purge generated media whose
		// only references are inside the conversation, and it decides that by
		// comparing the conversation's join count to the row's TOTAL ref_count.
		// The avatar's extra reference is what makes those unequal — i.e. the
		// user can't take the face out from under a preset that's still wearing
		// it via a checkbox about something else. Asserted here rather than
		// reasoned about, because it's a cross-module consequence of ref_count
		// tolerating a non-message referrer.
		const u = seedUser();
		const cm = makePreset(u.id);
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'here she is' }],
		});
		const { id: portrait } = insertMedia({
			userId: u.id,
			storagePath: `ab/cd/${Math.random().toString(36).slice(2)}.png`,
			contentType: 'image/png',
			byteSize: 2048,
			kind: 'image',
			origin: 'generated',
			sourceEndpointId: 'bridge',
			sourceModel: 'comfyui/sdxl',
			promptExcerpt: 'a portrait',
		});
		linkMessageMedia(msg.id, portrait);

		// Before it's an avatar it IS an orphan-to-be: one reference, all of it
		// inside this conversation.
		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({ images: 1, videos: 0 });

		setCustomModelAvatar(cm.id, u.id, portrait);
		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({ images: 0, videos: 0 });

		// …and it goes back to being offered once the preset lets go of it.
		setCustomModelAvatar(cm.id, u.id, null);
		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({ images: 1, videos: 0 });
	});
});

/**
 * The per-conversation override. Same reference discipline as the preset side,
 * plus one ordering rule that only shows up on delete.
 */
describe('conversation avatars', () => {
	function seedConversation(userId: string) {
		return createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
	}

	function generatedImage(userId: string) {
		return insertMedia({
			userId,
			storagePath: `ab/cd/${Math.random().toString(36).slice(2)}.png`,
			contentType: 'image/png',
			byteSize: 2048,
			kind: 'image',
			origin: 'generated',
			sourceEndpointId: 'bridge',
			sourceModel: 'comfyui/sdxl',
			promptExcerpt: 'a portrait',
		}).id;
	}

	it('takes and releases a reference like the preset path', () => {
		const u = seedUser();
		const conv = seedConversation(u.id);
		const m = makeUpload(u.id);

		expect(setConversationAvatar(conv.id, u.id, m)).toEqual({ ok: true });
		expect(mediaRow(m)).toMatchObject({ refCount: 1, unreferencedSince: null });

		expect(setConversationAvatar(conv.id, u.id, null)).toEqual({ ok: true });
		expect(mediaRow(m)?.refCount).toBe(0);
	});

	it('re-setting the same avatar does not double-count', () => {
		const u = seedUser();
		const conv = seedConversation(u.id);
		const m = makeUpload(u.id);
		setConversationAvatar(conv.id, u.id, m);
		setConversationAvatar(conv.id, u.id, m);
		expect(mediaRow(m)?.refCount).toBe(1);
	});

	it("refuses another user's media and another user's conversation", () => {
		const owner = seedUser();
		const other = seedUser();
		const conv = seedConversation(owner.id);
		expect(setConversationAvatar(conv.id, owner.id, makeUpload(other.id))).toEqual({
			ok: false,
			reason: 'media_not_found',
		});
		expect(setConversationAvatar(conv.id, other.id, makeUpload(other.id))).toEqual({
			ok: false,
			reason: 'not_found',
		});
	});

	it("still deletes the conversation's own portrait when asked to delete its media", () => {
		// The ordering rule. `deleteConversation` decides what to reap by asking
		// whether a media's ENTIRE ref_count is accounted for by links inside the
		// conversation — so the avatar's extra +1 would make its own portrait look
		// shared and spare it, against an explicit "delete media too". The delete
		// path releases the avatar reference BEFORE that analysis runs; this is
		// the regression guard for that order.
		const u = seedUser();
		const conv = seedConversation(u.id);
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'here I am' }],
		});
		const portrait = generatedImage(u.id);
		linkMessageMedia(msg.id, portrait);
		setConversationAvatar(conv.id, u.id, portrait);
		expect(mediaRow(portrait)?.refCount).toBe(2);

		const { ok, toUnlink } = deleteConversation(conv.id, u.id, { deleteMedia: true });

		expect(ok).toBe(true);
		expect(toUnlink.map((r) => r.id)).toContain(portrait);
		expect(mediaRow(portrait)?.hardDeletedAt).not.toBeNull();
	});

	it('releases the reference when the conversation is deleted without its media', () => {
		// The avatar was an upload from elsewhere, not generated here — deleting
		// the conversation must not strand it at a permanent +1.
		const u = seedUser();
		const conv = seedConversation(u.id);
		const m = makeUpload(u.id);
		setConversationAvatar(conv.id, u.id, m);

		expect(deleteConversation(conv.id, u.id).ok).toBe(true);
		expect(mediaRow(m)?.refCount).toBe(0);
		expect(findPurgeCandidates(Date.now() + 1).map((c) => c.id)).toContain(m);
	});
});

/**
 * The delete-conversation dialog's count and the delete itself have to agree.
 * They're computed by the same orphan rule but at different moments — the count
 * before the avatar reference is released, the delete after — so an avatar is
 * exactly the thing that can put them out of step.
 */
describe('conversation avatars — the delete dialog counts what delete removes', () => {
	function seedWithImages(userId: string, n: number) {
		const conv = createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const ids: string[] = [];
		let parent: string | null = null;
		for (let i = 0; i < n; i++) {
			const msg = appendMessage({
				conversationId: conv.id,
				parentMessageId: parent,
				role: 'assistant',
				parts: [{ type: 'text', text: `image ${i}` }],
			});
			parent = msg.id;
			const { id } = insertMedia({
				userId,
				storagePath: `ab/cd/${Math.random().toString(36).slice(2)}.png`,
				contentType: 'image/png',
				byteSize: 2048,
				kind: 'image',
				origin: 'generated',
				sourceEndpointId: 'bridge',
				sourceModel: 'comfyui/sdxl',
				promptExcerpt: 'a portrait',
			});
			linkMessageMedia(msg.id, id);
			ids.push(id);
		}
		return { conv, ids };
	}

	it('counts a portrait that is also the avatar', () => {
		// The reported symptom: an avatar-only conversation offered to delete
		// nothing, so the portrait outlived the conversation in the gallery.
		const u = seedUser();
		const { conv, ids } = seedWithImages(u.id, 1);
		setConversationAvatar(conv.id, u.id, ids[0]);

		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({ images: 1, videos: 0 });
	});

	it('does not promise fewer than it deletes', () => {
		// The worse half of the same bug: with a second image present the dialog
		// said "1" while the delete took both. Silent over-deletion — nothing
		// surfaces it until the gallery is short an image.
		const u = seedUser();
		const { conv, ids } = seedWithImages(u.id, 2);
		setConversationAvatar(conv.id, u.id, ids[0]);

		const promised = countOrphanMediaInConversation(conv.id, u.id);
		const { toUnlink } = deleteConversation(conv.id, u.id, { deleteMedia: true });

		expect(promised).toEqual({ images: 2, videos: 0 });
		expect(toUnlink).toHaveLength(promised.images + promised.videos);
	});

	it('leaves an avatar drawn in ANOTHER conversation alone', () => {
		// Not an orphan of this conversation: its message link lives elsewhere, so
		// deleting this one must neither count nor remove it.
		const u = seedUser();
		const { conv: other, ids } = seedWithImages(u.id, 1);
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		setConversationAvatar(conv.id, u.id, ids[0]);

		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({ images: 0, videos: 0 });
		deleteConversation(conv.id, u.id, { deleteMedia: true });
		expect(mediaRow(ids[0])?.hardDeletedAt).toBeNull();
		expect(countOrphanMediaInConversation(other.id, u.id)).toEqual({ images: 1, videos: 0 });
	});
});
