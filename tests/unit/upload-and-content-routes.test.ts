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
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('$lib/server/env', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/env')>()),
	mediaDir: () => mocks.root,
	derivedDir: () => mocks.root,
}));

import { POST as upload } from '../../src/routes/api/uploads/+server';
import { GET as content } from '../../src/routes/api/media/[id]/content/+server';
import { createSession, validateSessionToken } from '$lib/server/auth/session';
import { hardDeleteMediaForUser, insertMedia } from '$lib/server/db/queries/media';
import { media } from '$lib/server/db/schema';
import { getMediaStore } from '$lib/server/media/disk-store';
import { MAX_UPLOAD_BYTES_FILE, MAX_UPLOAD_BYTES_IMAGE } from '$lib/server/uploads/classify';

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

function getContent(id: string, headers: Record<string, string> = {}) {
	return call(
		content as Handler,
		new Request(`https://chat.example.test/api/media/${id}/content`, { headers }),
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

	it('404s a hard-deleted asset', async () => {
		const id = await stored('image/png', 'image');
		hardDeleteMediaForUser(id, user.id);
		expect((await getContent(id)).status).toBe(404);
	});

	it('round-trips an upload byte for byte', async () => {
		const out = await uploaded(new File([PNG], 'p.png', { type: 'image/png' }));
		const res = await getContent(out.id);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	});
});
