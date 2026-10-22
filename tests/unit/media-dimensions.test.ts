/** `media.width` / `media.height`: the probe, and the backfill for rows from
 *  before the columns. Real sharp, real files, in-memory DB. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
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

import {
	probeImageDimensions,
	probeStoredImage,
	storedDimensions,
} from '#lib/server/media/dimensions.js';
import { runDimensionsBackfillSweep } from '#lib/server/media/dimensions-backfill.js';
import {
	attachImageDimensions,
	insertMedia,
	linkMessageMedia,
	listConversationMediaRefs,
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
	it('reads the size from bytes', async () => {
		expect(await probeImageDimensions(await png(300, 200))).toEqual({ width: 300, height: 200 });
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

	it('answers 0 × 0 for something that is not an image', async () => {
		expect(await probeImageDimensions(Buffer.from('not an image'))).toEqual({
			width: 0,
			height: 0,
		});
	});
});

describe('probeStoredImage', () => {
	it('tells a bad file from a missing one from one it cannot read', async () => {
		write('a/b.png', await png(300, 200));
		write('a/bad.png', Buffer.from('garbage'));
		mkdirSync(resolve(mocks.dir, 'a/dir.png'));
		expect(await probeStoredImage(resolve(mocks.dir, 'a/b.png'))).toEqual({
			dims: { width: 300, height: 200 },
		});
		expect(await probeStoredImage(resolve(mocks.dir, 'a/bad.png'))).toEqual({
			dims: { width: 0, height: 0 },
		});
		expect(await probeStoredImage(resolve(mocks.dir, 'a/gone.png'))).toEqual({ missing: true });
		// A read error (EISDIR here; EIO, EACCES… in practice) is not a verdict on
		// the file: it must not reach sharp, which would call it undecodable.
		expect(await probeStoredImage(resolve(mocks.dir, 'a/dir.png'))).toHaveProperty('unavailable');
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

	it('leaves rows unprobed while the media directory is empty, as an unmounted volume is', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const u = seedUser();
		// Nothing on disk at all: every file reads as missing, which must not be
		// taken as the whole library gone.
		const id = seedImage(u.id, 'a/one.png');
		expect(await runDimensionsBackfillSweep()).toEqual({ filled: 0, drained: false });
		expect(dims(id)).toEqual({ width: null, height: null });

		// Once the volume is back, the same row is measured.
		write('a/one.png', await png(64, 32));
		expect(await runDimensionsBackfillSweep()).toEqual({ filled: 1, drained: true });
		expect(dims(id)).toEqual({ width: 64, height: 32 });
		warn.mockRestore();
	});

	it.skipIf(process.getuid?.() === 0)(
		'leaves a row it cannot read unprobed, and carries on past it',
		async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const u = seedUser();
			write('locked/one.png', await png(10, 10));
			write('open/two.png', await png(20, 10));
			const locked = seedImage(u.id, 'locked/one.png');
			const open = seedImage(u.id, 'open/two.png');
			// The queue is oldest first: the unreadable row heads it.
			getDb().update(media).set({ createdAt: 1 }).where(eq(media.id, locked)).run();
			chmodSync(resolve(mocks.dir, 'locked'), 0o000);
			try {
				// EACCES is "try again", not "unreadable": that row stays NULL, the one
				// behind it is filled, and the queue isn't drained.
				expect(await runDimensionsBackfillSweep()).toEqual({ filled: 1, drained: false });
				expect(dims(locked)).toEqual({ width: null, height: null });
				expect(dims(open)).toEqual({ width: 20, height: 10 });
			} finally {
				chmodSync(resolve(mocks.dir, 'locked'), 0o755);
			}
			expect(await runDimensionsBackfillSweep()).toEqual({ filled: 1, drained: true });
			expect(dims(locked)).toEqual({ width: 10, height: 10 });
			warn.mockRestore();
		},
	);

	it('stops the sweep when a whole batch cannot be read, as an unreachable volume', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const u = seedUser();
		// Fifty "files" that are directories: each read fails (EISDIR).
		const unreadable = Array.from({ length: 50 }, (_, i) => {
			mkdirSync(resolve(mocks.dir, `d/${i}.png`), { recursive: true });
			const id = seedImage(u.id, `d/${i}.png`);
			getDb()
				.update(media)
				.set({ createdAt: i + 1 })
				.where(eq(media.id, id))
				.run();
			return id;
		});
		write('a/last.png', await png(8, 8));
		const last = seedImage(u.id, 'a/last.png');

		expect(await runDimensionsBackfillSweep()).toEqual({ filled: 0, drained: false });
		expect(dims(last)).toEqual({ width: null, height: null });
		expect(dims(unreadable[0])).toEqual({ width: null, height: null });
		// One summary line, not one per file.
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
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
		attachImageDimensions(msgs, u.id);
		expect(msgs[0].parts[1]).toEqual({ type: 'image', mediaId: known, width: 640, height: 480 });
		expect(msgs[0].parts[2]).toEqual({ type: 'image', mediaId: unreadable });
		expect(msgs[1].parts[0]).toEqual({ type: 'image', mediaId: unprobed });
		expect(msgs[1].parts[1]).toEqual({ type: 'image', mediaId: known, width: 10, height: 20 });
	});

	it("never reads another user's media, whatever a part names", () => {
		const owner = seedUser();
		const other = seedUser();
		const theirs = seedImage(other.id, 'x/theirs.png', { dimensions: { width: 800, height: 600 } });
		const msgs: Array<{ parts: MessagePart[] }> = [{ parts: [{ type: 'image', mediaId: theirs }] }];
		attachImageDimensions(msgs, owner.id);
		expect(msgs[0].parts[0]).toEqual({ type: 'image', mediaId: theirs });
		attachImageDimensions(msgs, other.id);
		expect(msgs[0].parts[0]).toEqual({ type: 'image', mediaId: theirs, width: 800, height: 600 });
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

describe("the lightbox's slide list", () => {
	it("carries each slide's size, with the unreadable marker as null", () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::chat',
			modelKind: 'chat',
		});
		const sized = seedImage(u.id, 'x/s.png', { dimensions: { width: 640, height: 480 } });
		const bad = seedImage(u.id, 'x/b.png', { dimensions: { width: 0, height: 0 } });
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [
				{ type: 'image', mediaId: sized },
				{ type: 'image', mediaId: bad },
			],
		});
		linkMessageMedia(msg.id, sized);
		linkMessageMedia(msg.id, bad);
		const refs = listConversationMediaRefs(conv.id, u.id);
		expect(refs).toEqual(
			expect.arrayContaining([
				{ id: sized, kind: 'image', width: 640, height: 480 },
				{ id: bad, kind: 'image', width: null, height: null },
			]),
		);
	});
});
