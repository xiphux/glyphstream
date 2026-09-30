/**
 * Pausing an endpoint's queue — the gate half and the persisted half.
 *
 * What a pause must guarantee is narrow and all of it is load-bearing for the
 * case it exists for (restarting the backend behind a cap-1 image endpoint with
 * a queue stacked up in front of it):
 *  - the generation already running is left alone to finish;
 *  - nothing new is granted — not from the line, and not an arrival on an idle
 *    group, which would otherwise take the fast path onto a dead backend;
 *  - nobody loses their place, and a resume picks the line up in order;
 *  - the pause outlives the GlyphStream process, so recreating the whole stack
 *    doesn't bring the endpoint back unpaused before its backend is up.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	endpoints: new Map<string, unknown>(),
}));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('$lib/server/endpoints/release', () => ({ releaseEndpointResources: async () => true }));
vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: (id: string) => mocks.endpoints.get(id),
	listEndpoints: () => [...mocks.endpoints.values()],
}));

import {
	acquireEndpointSlot,
	type AcquireOptions,
	getResourceQueueDepth,
	isResourceGroupPaused,
	type QueuedInfo,
	resetEndpointGatesForTests,
	setResourceGroupPaused,
} from '$lib/server/endpoints/concurrency';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import {
	installPersistedPauses,
	pauseResourceGroup,
	resetPersistedPausesForTests,
} from '$lib/server/endpoints/pause';
import { getEndpointsStatus } from '$lib/server/endpoints/status';
import { pausedResourceGroups, users } from '$lib/server/db/schema';
import { DELETE, PUT } from '../../src/routes/api/admin/endpoints/[id]/pause/+server';

function acquire(endpoint: LoadedEndpoint, opts: Omit<AcquireOptions, 'work'> = {}) {
	return acquireEndpointSlot(endpoint, { ...opts, work: { purpose: 'image' } });
}

function ep(id: string, max: number, group = id): LoadedEndpoint {
	return {
		id,
		displayName: id,
		baseUrl: `http://${id}/v1`,
		apiKey: null,
		requestTimeoutSeconds: 120,
		providerQuirk: 'passthrough',
		groupBy: 'endpoint',
		supportsTools: false,
		maxConcurrent: max,
		resourceGroup: group,
		resourceGroupMaxConcurrent: max,
		release: null,
		contextWindow: null,
		modelContextWindows: {},
		modelPromptStyles: {},
		modelPromptHints: {},
	};
}

/** Settles a granted waiter's `takeSlot` promise chain. */
const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Tracks whether a pending acquisition has resolved yet. Swallows the
 *  rejection `resetEndpointGatesForTests` hands a waiter still in line at
 *  teardown — several tests end with one there on purpose. */
function track<T>(p: Promise<T>) {
	const t = { done: false, value: undefined as T | undefined };
	p.then(
		(v) => {
			t.done = true;
			t.value = v;
		},
		() => {},
	);
	return t;
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.endpoints.clear();
});

afterEach(() => {
	resetEndpointGatesForTests();
	resetPersistedPausesForTests();
	closeTestDb();
});

describe('gate', () => {
	it('lets the running generation finish, holds the line, and resumes it in order', async () => {
		const comfy = ep('comfy', 1);
		const running = await acquire(comfy);
		const a = track(acquire(comfy));
		const b = track(acquire(comfy));

		setResourceGroupPaused(comfy, true);
		// The holder is untouched by the pause; its release frees the slot but
		// grants nobody.
		running.release();
		await flush();
		expect(a.done).toBe(false);
		expect(getResourceQueueDepth('comfy')).toEqual({ active: 0, waiting: 2 });

		setResourceGroupPaused(comfy, false);
		await flush();
		expect(a.done).toBe(true);
		expect(b.done).toBe(false);
		a.value!.release();
		await flush();
		expect(b.done).toBe(true);
	});

	it('queues an arrival on an idle paused group instead of taking the fast path', async () => {
		// The fast path is the dangerous one: with the backend down for a restart,
		// a fresh request onto an idle group would go straight at it.
		const comfy = ep('comfy', 1);
		setResourceGroupPaused(comfy, true);
		const queued: QueuedInfo[] = [];
		const p = track(acquire(comfy, { onQueued: (i) => queued.push(i) }));
		await flush();
		expect(p.done).toBe(false);
		expect(queued).toEqual([{ ahead: 0, paused: true }]);
	});

	it('re-notifies every waiter on pause and resume, without moving the line', async () => {
		const comfy = ep('comfy', 1);
		const running = await acquire(comfy);
		const first: QueuedInfo[] = [];
		const second: QueuedInfo[] = [];
		track(acquire(comfy, { onQueued: (i) => first.push(i) }));
		track(acquire(comfy, { onQueued: (i) => second.push(i) }));

		setResourceGroupPaused(comfy, true);
		expect(first.at(-1)).toEqual({ ahead: 0, paused: true });
		expect(second.at(-1)).toEqual({ ahead: 1, paused: true });

		// Pausing twice is a no-op, not a second round of notifications.
		const before = second.length;
		setResourceGroupPaused(comfy, true);
		expect(second.length).toBe(before);

		setResourceGroupPaused(comfy, false);
		expect(second).toContainEqual({ ahead: 1, paused: false });
		running.release();
	});

	it('pauses the whole resource group, whichever member it was asked through', async () => {
		const llm = ep('llm', 1, 'gpu');
		const comfy = ep('comfy', 1, 'gpu');
		setResourceGroupPaused(comfy, true);
		const p = track(acquire(llm));
		await flush();
		expect(p.done).toBe(false);
		expect(isResourceGroupPaused('gpu')).toBe(true);
	});

	it('still lets a paused waiter leave the line on Stop', async () => {
		const comfy = ep('comfy', 1);
		setResourceGroupPaused(comfy, true);
		const ctl = new AbortController();
		const p = acquire(comfy, { signal: ctl.signal });
		ctl.abort();
		await expect(p).rejects.toThrow(/aborted/);
		expect(getResourceQueueDepth('comfy')).toEqual({ active: 0, waiting: 0 });
	});
});

describe('persistence', () => {
	it('survives a restart: a new process starts the group paused', async () => {
		const comfy = ep('comfy', 1);
		installPersistedPauses();
		pauseResourceGroup(comfy, true);
		expect(mocks.testDb.select().from(pausedResourceGroups).all()).toHaveLength(1);

		// A fresh process: no gates, no cached set, only the database.
		resetEndpointGatesForTests();
		resetPersistedPausesForTests();
		installPersistedPauses();

		expect(isResourceGroupPaused('comfy')).toBe(true);
		const p = track(acquire(comfy));
		await flush();
		expect(p.done).toBe(false);

		pauseResourceGroup(comfy, false);
		await flush();
		expect(p.done).toBe(true);
		expect(mocks.testDb.select().from(pausedResourceGroups).all()).toHaveLength(0);
	});

	it('reports a persisted pause on a group nothing has reached since the restart', () => {
		mocks.endpoints.set('comfy', ep('comfy', 1));
		mocks.testDb.insert(pausedResourceGroups).values({ resourceGroup: 'comfy', pausedAt: 1 }).run();
		installPersistedPauses();
		const status = getEndpointsStatus();
		expect(status.groups[0].paused).toBe(true);
	});
});

describe('PUT / DELETE /api/admin/endpoints/:id/pause', () => {
	function actor(role: 'admin' | 'user') {
		const u = seedUser();
		mocks.testDb.update(users).set({ role }).where(eq(users.id, u.id)).run();
		return { ...u, role } as unknown as App.Locals['user'];
	}

	async function call(handler: typeof PUT, user: App.Locals['user'], id: string) {
		const event = {
			params: { id },
			locals: { user, sessionId: null },
			setHeaders: () => {},
		} as unknown as RequestEvent<{ id: string }, '/api/admin/endpoints/[id]/pause'>;
		try {
			return await handler(event);
		} catch (e) {
			if (e && typeof e === 'object' && 'status' in e) return { status: Number(e.status) };
			throw e;
		}
	}

	beforeEach(() => {
		installPersistedPauses();
		mocks.endpoints.set('comfy', ep('comfy', 1));
	});

	it('pauses and resumes for an admin, returning the updated snapshot', async () => {
		const admin = actor('admin');
		const paused = (await call(PUT, admin, 'comfy')) as Response;
		expect(paused.status).toBe(200);
		expect(((await paused.json()) as { groups: Array<{ paused: boolean }> }).groups[0].paused).toBe(
			true,
		);

		const resumed = (await call(DELETE, admin, 'comfy')) as Response;
		expect(
			((await resumed.json()) as { groups: Array<{ paused: boolean }> }).groups[0].paused,
		).toBe(false);
	});

	it('refuses a non-admin and 404s an unknown endpoint', async () => {
		expect((await call(PUT, actor('user'), 'comfy')).status).toBe(403);
		expect(isResourceGroupPaused('comfy')).toBe(false);
		expect((await call(PUT, actor('admin'), 'nope')).status).toBe(404);
	});
});
