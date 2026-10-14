/**
 * POST /api/uploads → GET /api/media/[id]/content, end to end on a real disk
 * store, with real multipart parsing and real Range responses.
 *
 * uploads-classify.test.ts and media-content-type.test.ts cover the pure
 * helpers; the routes themselves never ran. What they add is where platform
 * upgrades land: `request.formData()` (undici, so a Node or Kit bump) and the
 * `Readable.toWeb` stream behind a 206. And the two security properties live in
 * the routes, not the helpers — the upload refusing SVG, and content forcing
 * `attachment` for anything that must never render inline in our origin.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB, root: '' }));
vi.mock('#lib/server/db/client.js', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('#lib/server/env.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/env.js')>()),
	mediaDir: () => mocks.root,
	derivedDir: () => mocks.root,
}));
const heic = vi.hoisted(() => ({ fail: false, unavailable: false }));
vi.mock('#lib/server/media/heic.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/media/heic.js')>();
	const { default: sharp } = await import('sharp');
	return {
		...actual,
		// The image's ffmpeg is proven by the Docker build; here, a stand-in that
		// writes a real JPEG where the route expects one.
		convertHeicToJpeg: async (_src: string, out: string) => {
			if (heic.fail) {
				throw new actual.HeicConversionError('Could not convert this HEIC photo', {
					unavailable: heic.unavailable,
				});
			}
			await sharp({ create: { width: 30, height: 40, channels: 3, background: '#c00' } })
				.jpeg()
				.toFile(out);
		},
	};
});
const displayVariant = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('#lib/server/media/display-variant.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/media/display-variant.js')>();
	return {
		...actual,
		getOrCreateDisplayVariant: (storagePath: string) => {
			displayVariant.calls.push(storagePath);
			return actual.getOrCreateDisplayVariant(storagePath);
		},
	};
});

import { POST as upload } from '../../src/routes/api/uploads/+server';
import { GET as content } from '../../src/routes/api/media/[id]/content/+server';
import { GET as display } from '../../src/routes/api/media/[id]/display/+server';
import { createSession, validateSessionToken } from '#lib/server/auth/session.js';
import { insertMedia, purgeTrashForUser, trashMediaForUser } from '#lib/server/db/queries/media.js';
import { media } from '#lib/server/db/schema.js';
import { getMediaStore } from '#lib/server/media/disk-store.js';
import { MAX_UPLOAD_BYTES_FILE, MAX_UPLOAD_BYTES_IMAGE } from '#lib/server/uploads/classify.js';

type Handler = (event: RequestEvent) => Promise<Response> | Response;
let user: NonNullable<App.Locals['user']>;

async function call(
	handler: Handler,
	request: Request,
	params: Record<string, string> = {},
): Promise<Response> {
	const event = {
		url: new URL(request.url),
		params,
		request,
		locals: { user, sessionId: null },
	} as unknown as RequestEvent;
	try {
		return await handler(event);
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) {
			return new Response(JSON.stringify((e as { body?: unknown }).body ?? null), {
				status: Number(e.status),
			});
		}
		throw e;
	}
}

function uploadRequest(file: File | null, headers: Record<string, string> = {}): Request {
	const form = new FormData();
	if (file) form.set('file', file);
	return new Request('https://chat.example.test/api/uploads', {
		method: 'POST',
		body: form,
		headers,
	});
}

async function uploaded(file: File) {
	const res = await call(upload as Handler, uploadRequest(file));
	expect(res.status).toBe(200);
	return (await res.json()) as {
		id: string;
		kind: string;
		byteSize: number;
		originalFilename: string | null;
	};
}

function getContent(id: string, headers: Record<string, string> = {}, query = '') {
	return call(
		content as Handler,
		new Request(`https://chat.example.test/api/media/${id}/content${query}`, { headers }),
		{ id },
	);
}

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.root = mkdtempSync(join(tmpdir(), 'gs-upload-route-'));
	user = validateSessionToken(createSession(seedUser().id).token)!.user;
});

afterEach(() => {
	closeTestDb();
	rmSync(mocks.root, { recursive: true, force: true });
});

describe('POST /api/uploads', () => {
	it('stores an image upload as a purgeable, unreferenced row with the exact bytes', async () => {
		const out = await uploaded(new File([PNG], 'photo.png', { type: 'image/png' }));
		expect(out).toMatchObject({ kind: 'image', byteSize: PNG.length, originalFilename: null });

		const row = mocks.testDb.select().from(media).where(eq(media.id, out.id)).get()!;
		expect(row).toMatchObject({ userId: user.id, origin: 'uploaded', refCount: 0 });
		expect(row.unreferencedSince).not.toBeNull();
		expect(new Uint8Array(readFileSync(resolve(mocks.root, row.storagePath)))).toEqual(PNG);
	});

	it('keeps the original filename for a document', async () => {
		const out = await uploaded(new File(['a,b\n1,2\n'], 'Q4 budget.csv', { type: 'text/csv' }));
		expect(out).toMatchObject({ kind: 'file', originalFilename: 'Q4 budget.csv' });
	});

	it.each([
		['image/svg+xml', 'svg executes script in our origin'],
		['image/svg+xml; charset=utf-8', 'parameters must not slip past the refusal'],
		['text/html', 'not an accepted document type'],
		['application/x-msdownload', 'not an accepted document type'],
	])('refuses %s with 415 (%s)', async (type) => {
		const res = await call(
			upload as Handler,
			uploadRequest(new File(['<svg onload="alert(1)"/>'], 'x', { type })),
		);
		expect(res.status).toBe(415);
		expect(mocks.testDb.select().from(media).all()).toEqual([]);
	});

	it('refuses an empty file', async () => {
		const res = await call(
			upload as Handler,
			uploadRequest(new File([], 'e.png', { type: 'image/png' })),
		);
		expect(res.status).toBe(400);
	});

	it('refuses a request with no file field, or no multipart body', async () => {
		expect((await call(upload as Handler, uploadRequest(null))).status).toBe(400);
		const notMultipart = new Request('https://chat.example.test/api/uploads', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect((await call(upload as Handler, notMultipart)).status).toBe(400);
	});

	it('refuses an oversized declared Content-Length before reading the body', async () => {
		const req = uploadRequest(new File([PNG], 'p.png', { type: 'image/png' }), {
			'content-length': String(MAX_UPLOAD_BYTES_FILE + 10 * 1024 * 1024),
		});
		const formData = vi.spyOn(req, 'formData');
		expect((await call(upload as Handler, req)).status).toBe(413);
		expect(formData).not.toHaveBeenCalled();
	});

	it("answers 413 when adapter-node's BODY_SIZE_LIMIT cut the body off", async () => {
		// adapter-node aborts the body past BODY_SIZE_LIMIT and formData() then
		// rejects with this wording; matching only "exceeded" sent it to the
		// misleading "must be multipart" 400.
		const req = uploadRequest(new File([PNG], 'p.png', { type: 'image/png' }));
		vi.spyOn(req, 'formData').mockRejectedValue(
			new Error('Content-length of 26214602 exceeds limit of 26214400 bytes.'),
		);
		const res = await call(upload as Handler, req);
		expect(res.status).toBe(413);
	});

	it.each([
		['image/heic', 'IMG_0001.HEIC'],
		['', 'IMG_0002.heic'], // a browser with no .heic mapping sends it untyped
	])('stores a HEIC photo (%j, %s) as the JPEG it converts to', async (type, name) => {
		heic.fail = false;
		const body = await uploaded(new File([new Uint8Array([1, 2, 3, 4])], name, { type }));
		expect(body).toMatchObject({ kind: 'image', originalFilename: null });
		const row = mocks.testDb.select().from(media).where(eq(media.id, body.id)).get()!;
		expect(row.contentType).toBe('image/jpeg');
		const res = await getContent(body.id);
		expect(res.headers.get('content-type')).toBe('image/jpeg');
		expect(new Uint8Array(await res.arrayBuffer()).subarray(0, 2)).toEqual(
			new Uint8Array([0xff, 0xd8]),
		);
	});

	it('answers 503, not 415, when the server cannot convert, storing nothing', async () => {
		heic.fail = true;
		heic.unavailable = true;
		const file = new File([new Uint8Array([1, 2, 3])], 'IMG_0004.HEIC', { type: 'image/heic' });
		const res = await call(upload as Handler, uploadRequest(file));
		expect(res.status).toBe(503);
		expect(mocks.testDb.select().from(media).all()).toEqual([]);
		heic.fail = false;
		heic.unavailable = false;
	});

	it('refuses a HEIC that will not convert, storing nothing', async () => {
		heic.fail = true;
		const file = new File([new Uint8Array([1, 2, 3])], 'IMG_0003.HEIC', { type: 'image/heic' });
		const res = await call(upload as Handler, uploadRequest(file));
		expect(res.status).toBe(415);
		expect(mocks.testDb.select().from(media).all()).toEqual([]);
		heic.fail = false;
	});

	it('applies the per-kind limit: an image over the image cap is 413', async () => {
		const big = new File([new Uint8Array(MAX_UPLOAD_BYTES_IMAGE + 1)], 'big.png', {
			type: 'image/png',
		});
		expect((await call(upload as Handler, uploadRequest(big))).status).toBe(413);
		expect(mocks.testDb.select().from(media).all()).toEqual([]);
	});
});

describe('GET /api/media/[id]/content', () => {
	const BYTES = new TextEncoder().encode('0123456789');

	async function stored(contentType: string, kind: 'image' | 'video' | 'file', name?: string) {
		const ref = await getMediaStore().put({ bytes: Buffer.from(BYTES), contentType, kind });
		return insertMedia({
			userId: user.id,
			storagePath: ref.storagePath,
			// Written as-is, so a legacy parameterised type reaches the route.
			contentType,
			byteSize: BYTES.length,
			kind,
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
			originalFilename: name ?? null,
		}).id;
	}

	it('serves the full body with length, type, and range support advertised', async () => {
		const id = await stored('video/mp4', 'video');
		const res = await getContent(id);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('video/mp4');
		expect(res.headers.get('content-length')).toBe('10');
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect(res.headers.get('content-disposition')).toBeNull();
		expect(await res.text()).toBe('0123456789');
	});

	it.each([
		['bytes=2-5', '2345', 'bytes 2-5/10'],
		['bytes=7-', '789', 'bytes 7-9/10'],
		['bytes=-3', '789', 'bytes 7-9/10'],
		['bytes=8-99', '89', 'bytes 8-9/10'],
	])('answers Range %s with a 206 slice', async (range, body, contentRange) => {
		const id = await stored('video/mp4', 'video');
		const res = await getContent(id, { range });
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(contentRange);
		expect(res.headers.get('content-length')).toBe(String(body.length));
		expect(await res.text()).toBe(body);
	});

	it.each(['bytes=20-30', 'bytes=0-1,4-5', 'bytes=5-2', 'items=0-1'])(
		'serves the whole body for an unusable Range (%s)',
		async (range) => {
			const id = await stored('video/mp4', 'video');
			const res = await getContent(id, { range });
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('0123456789');
		},
	);

	it('forces a download for documents, with a safe filename', async () => {
		const id = await stored('application/pdf', 'file', 'résumé "final".pdf');
		const res = await getContent(id);
		expect(res.headers.get('content-disposition')).toBe(
			`attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`,
		);
	});

	it('forces a download for SVG even as an image, including a parameterised legacy type', async () => {
		for (const type of ['image/svg+xml', 'image/svg+xml; charset=utf-8']) {
			const res = await getContent(await stored(type, 'image'));
			expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
			expect(res.headers.get('content-type')).toBe('image/svg+xml');
		}
	});

	it('serves an SVG as itself on the display route, never as a raster copy', async () => {
		displayVariant.calls = [];
		const id = await stored('image/svg+xml', 'image', 'chart.svg');
		const res = await call(
			display as Handler,
			new Request(`https://chat.example.test/api/media/${id}/display`),
			{ id },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/svg+xml');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
		expect(await res.text()).toBe('0123456789');
		expect(displayVariant.calls).toEqual([]);

		// A raster still asks for its display copy.
		const png = await stored('image/png', 'image');
		await call(
			display as Handler,
			new Request(`https://chat.example.test/api/media/${png}/display`),
			{ id: png },
		);
		expect(displayVariant.calls).toHaveLength(1);
	});

	it('404s a trashed asset on its live URL, and serves it only to the trash view', async () => {
		const id = await stored('image/png', 'image');
		expect((await getContent(id, {}, '?trash=1')).status).toBe(404);
		trashMediaForUser(id, user.id);
		expect((await getContent(id)).status).toBe(404);
		expect((await getContent(id, {}, '?trash=1')).status).toBe(200);
		purgeTrashForUser([id], user.id);
		expect((await getContent(id, {}, '?trash=1')).status).toBe(404);
	});

	it('round-trips an upload byte for byte', async () => {
		const out = await uploaded(new File([PNG], 'p.png', { type: 'image/png' }));
		const res = await getContent(out.id);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	});
});
