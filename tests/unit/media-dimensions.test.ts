/** `media.width` / `media.height`: the probe, and the backfill for rows from
 *  before the columns. Real sharp, real files, in-memory DB. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ dir: '' }));
vi.mock('#lib/server/env.js', () => ({
	mediaDir: () => mocks.dir,
	derivedDir: () => mocks.dir,
	dbPath: () => './data/glyphstream.db',
	configPath: () => './config.toml',
}));

import { probeImageDimensions, storedDimensions } from '#lib/server/media/dimensions.js';
import { runDimensionsBackfillSweep } from '#lib/server/media/dimensions-backfill.js';
import {
	attachImageDimensions,
	insertMedia,
	setMediaDimensions,
} from '#lib/server/db/queries/media.js';
import { createConversation, getConversationDetail } from '#lib/server/db/queries/conversations.js';
import { appendMessage } from '#lib/server/db/queries/messages.js';
import type { MessagePart } from '#lib/types/api.js';
import { getDb } from '#lib/server/db/client.js';
import { media } from '#lib/server/db/schema.js';

function png(width: number, height: number): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: '#888' } })
		.png()
		.toBuffer();
}

function write(storagePath: string, bytes: Buffer): void {
	const abs = resolve(mocks.dir, storagePath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
}

function seedImage(
	userId: string,
	storagePath: string,
	extra: Partial<Parameters<typeof insertMedia>[0]> = {},
): string {
	return insertMedia({
		userId,
		storagePath,
		contentType: 'image/png',
		byteSize: 1,
		kind: 'image',
		sourceEndpointId: null,
		sourceModel: null,
		promptExcerpt: null,
		...extra,
	}).id;
}

function dims(id: string) {
	return getDb()
		.select({ width: media.width, height: media.height })
		.from(media)
		.where(eq(media.id, id))
		.get();
}

beforeEach(() => {
	mocks.dir = mkdtempSync(join(tmpdir(), 'gs-dims-'));
	createTestDb();
});
afterEach(() => {
	closeTestDb();
	rmSync(mocks.dir, { recursive: true, force: true });
});

describe('probeImageDimensions', () => {
	it('reads the size from bytes and from a path', async () => {
		const bytes = await png(300, 200);
		expect(await probeImageDimensions(bytes)).toEqual({ width: 300, height: 200 });
		write('a/b.png', bytes);
		expect(await probeImageDimensions(resolve(mocks.dir, 'a/b.png'))).toEqual({
			width: 300,
			height: 200,
		});
	});

	it('reports the upright size of an EXIF-rotated photo', async () => {
		// Orientation 6 = rotate 90° clockwise to display: stored 300×200, shown 200×300.
		const jpeg = await sharp({
			create: { width: 300, height: 200, channels: 3, background: '#888' },
		})
			.jpeg()
			.withMetadata({ orientation: 6 })
			.toBuffer();
		expect(await probeImageDimensions(jpeg)).toEqual({ width: 200, height: 300 });
	});

	it('answers 0 × 0 for something that is not an image, or not there', async () => {
		expect(await probeImageDimensions(Buffer.from('not an image'))).toEqual({
			width: 0,
			height: 0,
		});
		expect(await probeImageDimensions(resolve(mocks.dir, 'missing.png'))).toEqual({
			width: 0,
			height: 0,
		});
	});
});

describe('storedDimensions', () => {
	it('treats NULL and the 0 × 0 marker as absent', () => {
		expect(storedDimensions(null, null)).toBeNull();
		expect(storedDimensions(0, 0)).toBeNull();
		expect(storedDimensions(640, 480)).toEqual({ width: 640, height: 480 });
	});
});

describe('insertMedia', () => {
	it('stores the dimensions it is given, and NULL without them', () => {
		const u = seedUser();
		const a = seedImage(u.id, 'x/a.png', { dimensions: { width: 10, height: 20 } });
		const b = seedImage(u.id, 'x/b.png');
		expect(dims(a)).toEqual({ width: 10, height: 20 });
		expect(dims(b)).toEqual({ width: null, height: null });
	});
});

describe('setMediaDimensions', () => {
	it('fills an unprobed row once, and never overwrites a recorded size', () => {
		const u = seedUser();
		const id = seedImage(u.id, 'x/a.png');
		expect(setMediaDimensions(id, { width: 5, height: 6 })).toBe(true);
		expect(setMediaDimensions(id, { width: 7, height: 8 })).toBe(false);
		expect(dims(id)).toEqual({ width: 5, height: 6 });
	});
});

describe('runDimensionsBackfillSweep', () => {
	it('reports drained when there is nothing to do', async () => {
		expect(await runDimensionsBackfillSweep()).toEqual({ filled: 0, drained: true });
	});

	it('fills unprobed images across users, marking unreadable ones 0 × 0', async () => {
		const u1 = seedUser();
		const u2 = seedUser();
		write('a/one.png', await png(640, 480));
		write('a/two.png', await png(100, 400));
		write('a/bad.png', Buffer.from('garbage'));
		const one = seedImage(u1.id, 'a/one.png');
		const two = seedImage(u2.id, 'a/two.png');
		const bad = seedImage(u1.id, 'a/bad.png');
		const gone = seedImage(u1.id, 'a/gone.png');

		expect(await runDimensionsBackfillSweep()).toEqual({ filled: 4, drained: true });
		expect(dims(one)).toEqual({ width: 640, height: 480 });
		expect(dims(two)).toEqual({ width: 100, height: 400 });
		expect(dims(bad)).toEqual({ width: 0, height: 0 });
		expect(dims(gone)).toEqual({ width: 0, height: 0 });
		// Nothing left: a second sweep finds the queue empty.
		expect(await runDimensionsBackfillSweep()).toEqual({ filled: 0, drained: true });
	});

	it('skips non-images and rows whose bytes were purged, but fills the trash', async () => {
		const u = seedUser();
		write('a/trashed.png', await png(20, 10));
		const video = insertMedia({
			userId: u.id,
			storagePath: 'a/clip.mp4',
			contentType: 'video/mp4',
			byteSize: 1,
			kind: 'video',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
		}).id;
		const purged = seedImage(u.id, 'a/purged.png');
		const trashed = seedImage(u.id, 'a/trashed.png');
		const now = Date.now();
		getDb().update(media).set({ deletedAt: now, purgedAt: now }).where(eq(media.id, purged)).run();
		getDb().update(media).set({ deletedAt: now }).where(eq(media.id, trashed)).run();

		expect(await runDimensionsBackfillSweep()).toEqual({ filled: 1, drained: true });
		expect(dims(trashed)).toEqual({ width: 20, height: 10 });
		expect(dims(video)).toEqual({ width: null, height: null });
		expect(dims(purged)).toEqual({ width: null, height: null });
	});
});

describe('attachImageDimensions', () => {
	it('fills unsized image parts from their rows, leaving sized and unknown ones alone', () => {
		const u = seedUser();
		const known = seedImage(u.id, 'x/known.png', { dimensions: { width: 640, height: 480 } });
		const unreadable = seedImage(u.id, 'x/bad.png', { dimensions: { width: 0, height: 0 } });
		const unprobed = seedImage(u.id, 'x/new.png');
		const msgs: Array<{ parts: MessagePart[] }> = [
			{
				parts: [
					{ type: 'text', text: 'hi' },
					{ type: 'image', mediaId: known },
					{ type: 'image', mediaId: unreadable },
				],
			},
			{
				parts: [
					{ type: 'image', mediaId: unprobed },
					// Already carries a size (a part persisted since): kept as-is.
					{ type: 'image', mediaId: known, width: 10, height: 20 },
				],
			},
		];
		attachImageDimensions(msgs);
		expect(msgs[0].parts[1]).toEqual({ type: 'image', mediaId: known, width: 640, height: 480 });
		expect(msgs[0].parts[2]).toEqual({ type: 'image', mediaId: unreadable });
		expect(msgs[1].parts[0]).toEqual({ type: 'image', mediaId: unprobed });
		expect(msgs[1].parts[1]).toEqual({ type: 'image', mediaId: known, width: 10, height: 20 });
	});

	it("is applied to the chat page's branch, windowed or not", () => {
		const u = seedUser();
		const id = seedImage(u.id, 'x/photo.png', { dimensions: { width: 300, height: 900 } });
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::chat',
			modelKind: 'chat',
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'image', mediaId: id }],
		});
		for (const options of [undefined, { messageWindow: 20 }]) {
			const detail = getConversationDetail(conv.id, u.id, options)!;
			expect(detail.messages[0].parts[0]).toEqual({
				type: 'image',
				mediaId: id,
				width: 300,
				height: 900,
			});
		}
	});
});
