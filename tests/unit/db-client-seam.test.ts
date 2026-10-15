/**
 * The test seam on `getDb()`: `createTestDb()` installs an in-memory database
 * in place of the on-disk one, and without it a test is refused rather than
 * handed the developer's own `data/glyphstream.db`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '#lib/server/db/client.js';
import { closeTestDb, createTestDb } from './_helpers/test-db';

afterEach(() => closeTestDb());

describe('getDb under test', () => {
	it('returns the database createTestDb installed', () => {
		const db = createTestDb();
		expect(getDb()).toBe(db);
	});

	it('refuses to open the on-disk database once the test database is closed', () => {
		createTestDb();
		closeTestDb();
		expect(() => getDb()).toThrow(/createTestDb/);
	});
});
