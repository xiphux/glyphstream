/** The opt-in per-user generation cap: off by default, never for admins. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB, max: null as number | null }));
vi.mock('#lib/server/endpoints/config.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/config.js')>()),
	getMaxQueuedGenerationsPerUser: () => mocks.max,
}));

import { enforceGenerationCap } from '#lib/server/generation/user-cap.js';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { registerInFlight, resetInFlight } from '#lib/server/streaming/in-flight.js';
import {
	ConfigError,
	loadMaxQueuedGenerationsPerUser,
	type LoadedEndpoint,
} from '#lib/server/endpoints/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const endpoint = { id: 'gpu' } as LoadedEndpoint;

function conv(userId: string): string {
	return createConversation({ userId, endpointId: 'gpu', modelId: 'gpu::m', modelKind: 'image' })
		.id;
}

/** `n` fan-out branches in flight in a fresh conversation of `userId`'s. */
function inFlight(userId: string, n: number): void {
	const id = conv(userId);
	for (let i = 0; i < n; i++) registerInFlight(id, endpoint, `branch-${i}`);
}

function refused(user: { id: string; role: 'admin' | 'user' }): boolean {
	try {
		enforceGenerationCap(user);
		return false;
	} catch (e) {
		expect(e).toMatchObject({ status: 429 });
		return true;
	}
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.max = null;
});
afterEach(() => {
	resetInFlight();
	closeTestDb();
});

describe('enforceGenerationCap', () => {
	it('never refuses when no cap is configured', () => {
		const u = seedUser();
		inFlight(u.id, 500);
		expect(refused({ id: u.id, role: 'user' })).toBe(false);
	});

	it('refuses a user at the configured cap, counting across their conversations', () => {
		mocks.max = 3;
		const u = seedUser();
		inFlight(u.id, 2);
		expect(refused({ id: u.id, role: 'user' })).toBe(false);
		inFlight(u.id, 1);
		expect(refused({ id: u.id, role: 'user' })).toBe(true);
	});

	it('never applies to an admin', () => {
		mocks.max = 1;
		const admin = seedUser();
		inFlight(admin.id, 50);
		expect(refused({ id: admin.id, role: 'admin' })).toBe(false);
	});

	it("doesn't count another user's generations", () => {
		mocks.max = 2;
		const a = seedUser();
		const b = seedUser();
		inFlight(b.id, 10);
		expect(refused({ id: a.id, role: 'user' })).toBe(false);
	});
});

describe('[limits] max_queued_generations_per_user', () => {
	const file = (body: string) => {
		const p = join(mkdtempSync(join(tmpdir(), 'gs-limits-')), 'config.toml');
		writeFileSync(p, body);
		return p;
	};

	it('is unset (no cap) when the block or key is absent', () => {
		expect(loadMaxQueuedGenerationsPerUser(file(''))).toBeNull();
		expect(loadMaxQueuedGenerationsPerUser(file('[limits]\n'))).toBeNull();
	});

	it('reads a positive integer and refuses anything else', () => {
		expect(
			loadMaxQueuedGenerationsPerUser(file('[limits]\nmax_queued_generations_per_user = 40\n')),
		).toBe(40);
		expect(() =>
			loadMaxQueuedGenerationsPerUser(file('[limits]\nmax_queued_generations_per_user = 0\n')),
		).toThrow(ConfigError);
	});
});
