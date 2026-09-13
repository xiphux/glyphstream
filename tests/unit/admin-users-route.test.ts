/**
 * PATCH / DELETE /api/admin/users/[id] — the admin's account controls.
 *
 * Disabling is the operator's revocation lever, so what it must do is end the
 * target's access NOW: their live session stops resolving on the next request.
 * The guard rails are API-enforced, not just UI: no acting on yourself, and no
 * removing the last active admin.
 *
 * Deleting must remove what the confirmation dialog says it removes — "all of
 * its conversations, media, and settings". The FK cascade takes the rows, but
 * the media BYTES were left on disk with nothing able to find them again (the
 * purger walks rows), which this file caught.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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

import { DELETE, PATCH } from '../../src/routes/api/admin/users/[id]/+server';
import { createSession, validateSessionToken } from '$lib/server/auth/session';
import { createConversation } from '$lib/server/db/queries/conversations';
import { hardDeleteMediaForUser, insertMedia } from '$lib/server/db/queries/media';
import { conversations, media, sessions, users } from '$lib/server/db/schema';
import { getMediaStore } from '$lib/server/media/disk-store';
import { thumbStoragePath } from '$lib/server/media/thumbnail';
import { registerInFlight, resetInFlight } from '$lib/server/streaming/in-flight';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

type Handler = (event: RequestEvent) => Promise<Response> | Response;

async function invoke(
	handler: Handler,
	actor: App.Locals['user'],
	targetId: string,
	body?: unknown,
): Promise<number> {
	const url = new URL(`/api/admin/users/${targetId}`, 'https://chat.example.test');
	const event = {
		url,
		params: { id: targetId },
		locals: { user: actor, sessionId: null } as App.Locals,
		request: new Request(url, {
			method: body === undefined ? 'DELETE' : 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	} as unknown as RequestEvent;
	try {
		return (await handler(event)).status;
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) return Number(e.status);
		throw e;
	}
}

function makeUser(role: 'admin' | 'user' = 'user') {
	const u = seedUser();
	mocks.testDb.update(users).set({ role }).where(eq(users.id, u.id)).run();
	const { token } = createSession(u.id);
	return { id: u.id, token, locals: validateSessionToken(token)!.user };
}

async function storeMedia(userId: string, withThumb = true) {
	const ref = await getMediaStore().put({
		bytes: Buffer.from('fake image bytes'),
		contentType: 'image/png',
		kind: 'image',
	});
	const { id } = insertMedia({
		userId,
		storagePath: ref.storagePath,
		contentType: 'image/png',
		byteSize: 16,
		kind: 'image',
		sourceEndpointId: null,
		sourceModel: null,
		promptExcerpt: null,
	});
	if (withThumb) {
		const thumb = resolve(mocks.root, thumbStoragePath(ref.storagePath));
		mkdirSync(dirname(thumb), { recursive: true });
		writeFileSync(thumb, 'thumb');
	}
	return {
		id,
		original: resolve(mocks.root, ref.storagePath),
		thumb: resolve(mocks.root, thumbStoragePath(ref.storagePath)),
	};
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.root = mkdtempSync(join(tmpdir(), 'gs-admin-users-'));
});

afterEach(() => {
	resetInFlight();
	closeTestDb();
	rmSync(mocks.root, { recursive: true, force: true });
});

describe('authorization', () => {
	it('refuses a non-admin (403) and an anonymous caller (401)', async () => {
		const target = makeUser();
		const user = makeUser();
		expect(await invoke(PATCH as Handler, user.locals, target.id, { disabled: true })).toBe(403);
		expect(await invoke(DELETE as Handler, user.locals, target.id)).toBe(403);
		expect(await invoke(PATCH as Handler, null, target.id, { disabled: true })).toBe(401);
		expect(await invoke(DELETE as Handler, null, target.id)).toBe(401);
		expect(validateSessionToken(target.token)).not.toBeNull();
	});
});

describe('PATCH disabled', () => {
	it('ends the target’s live session immediately, and enabling restores access', async () => {
		const admin = makeUser('admin');
		const target = makeUser();
		expect(validateSessionToken(target.token)).not.toBeNull();

		expect(await invoke(PATCH as Handler, admin.locals, target.id, { disabled: true })).toBe(200);
		expect(validateSessionToken(target.token)).toBeNull();

		expect(await invoke(PATCH as Handler, admin.locals, target.id, { disabled: false })).toBe(200);
		expect(validateSessionToken(target.token)?.user.id).toBe(target.id);
	});

	it('refuses to act on the caller’s own account', async () => {
		const admin = makeUser('admin');
		expect(await invoke(PATCH as Handler, admin.locals, admin.id, { disabled: true })).toBe(400);
		expect(validateSessionToken(admin.token)).not.toBeNull();
	});

	it('validates the body and the target', async () => {
		const admin = makeUser('admin');
		const target = makeUser();
		expect(await invoke(PATCH as Handler, admin.locals, target.id, { disabled: 'yes' })).toBe(400);
		expect(await invoke(PATCH as Handler, admin.locals, 'no-such-user', { disabled: true })).toBe(
			404,
		);
	});

	it('allows disabling another admin while one active admin remains', async () => {
		const admin = makeUser('admin');
		const other = makeUser('admin');
		expect(await invoke(PATCH as Handler, admin.locals, other.id, { disabled: true })).toBe(200);
	});

	it('refuses to disable or delete the last active admin', async () => {
		// Reachable when the actor's session still says admin but the DB no
		// longer does (demoted mid-session), leaving the target as the only one.
		const actor = makeUser('admin');
		const last = makeUser('admin');
		mocks.testDb.update(users).set({ role: 'user' }).where(eq(users.id, actor.id)).run();

		expect(await invoke(PATCH as Handler, actor.locals, last.id, { disabled: true })).toBe(409);
		expect(await invoke(DELETE as Handler, actor.locals, last.id)).toBe(409);
		expect(validateSessionToken(last.token)).not.toBeNull();
		// Enabling can never strand anyone.
		expect(await invoke(PATCH as Handler, actor.locals, last.id, { disabled: false })).toBe(200);
	});
});

describe('DELETE', () => {
	it('removes the account, its rows, and its media files from disk', async () => {
		const admin = makeUser('admin');
		const target = makeUser();
		createConversation({ userId: target.id, endpointId: 'e', modelId: 'm', modelKind: null });
		const live = await storeMedia(target.id);
		const tombstoned = await storeMedia(target.id, false);
		hardDeleteMediaForUser(tombstoned.id, target.id);
		rmSync(tombstoned.original); // what the gallery delete already did

		const bystander = makeUser();
		const theirs = await storeMedia(bystander.id);

		expect(await invoke(DELETE as Handler, admin.locals, target.id)).toBe(200);

		expect(mocks.testDb.select().from(users).where(eq(users.id, target.id)).all()).toEqual([]);
		expect(
			mocks.testDb.select().from(sessions).where(eq(sessions.userId, target.id)).all(),
		).toEqual([]);
		expect(
			mocks.testDb.select().from(conversations).where(eq(conversations.userId, target.id)).all(),
		).toEqual([]);
		expect(mocks.testDb.select().from(media).where(eq(media.userId, target.id)).all()).toEqual([]);

		expect(existsSync(live.original)).toBe(false);
		expect(existsSync(live.thumb)).toBe(false);

		// Another user's files are untouched.
		expect(existsSync(theirs.original)).toBe(true);
		expect(existsSync(theirs.thumb)).toBe(true);
		expect(validateSessionToken(bystander.token)).not.toBeNull();
	});

	it('stops generations still streaming into the user’s conversations, and no one else’s', async () => {
		const endpoint = { id: 'bridge', baseUrl: 'http://localhost/v1' } as LoadedEndpoint;
		const admin = makeUser('admin');
		const target = makeUser();
		const bystander = makeUser();
		const conv = (userId: string, archived = false) => {
			const { id } = createConversation({ userId, endpointId: 'e', modelId: 'm', modelKind: null });
			if (archived) {
				mocks.testDb
					.update(conversations)
					.set({ archivedAt: 1 })
					.where(eq(conversations.id, id))
					.run();
			}
			return id;
		};
		const active = registerInFlight(conv(target.id), endpoint);
		const archived = registerInFlight(conv(target.id, true), endpoint);
		const theirs = registerInFlight(conv(bystander.id), endpoint);

		expect(await invoke(DELETE as Handler, admin.locals, target.id)).toBe(200);

		expect(active.controller.signal.aborted).toBe(true);
		expect(archived.controller.signal.aborted).toBe(true);
		expect(theirs.controller.signal.aborted).toBe(false);
	});

	it('refuses self-deletion and 404s an unknown user', async () => {
		const admin = makeUser('admin');
		expect(await invoke(DELETE as Handler, admin.locals, admin.id)).toBe(400);
		expect(await invoke(DELETE as Handler, admin.locals, 'no-such-user')).toBe(404);
	});
});
