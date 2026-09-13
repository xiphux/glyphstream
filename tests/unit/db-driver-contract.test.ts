/**
 * The drizzle-orm/node-sqlite behaviors the app is written against, pinned
 * with the REAL driver rather than a hand-built imitation.
 *
 * db-errors.test.ts proves `isUniqueViolation` against a simulated wrapper
 * shaped like rc.4's DrizzleQueryError. That shape is exactly what can move in
 * the next RC, and the code relying on it maps duplicates to 409s and join
 * races to the right error. Likewise the transaction semantics CLAUDE.md warns
 * about — a nested `db.transaction()` throws, only `tx.transaction()` gives a
 * savepoint — are load-bearing in media, snippets import and the join flows,
 * and would change silently if drizzle started (or stopped) promoting nesting.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { isUniqueViolation } from '$lib/server/db/errors';
import { oauthAccounts, sessions, users } from '$lib/server/db/schema';

let db: TestDB;

const user = (id: string, email: string | null = `${id}@example.test`) => ({
	id,
	email,
	displayName: id,
	createdAt: Date.now(),
});

function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	throw new Error('expected a throw');
}

beforeEach(() => {
	db = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('query errors, as drizzle actually throws them', () => {
	it('a duplicate primary key is recognised as a unique violation', () => {
		db.insert(users).values(user('u1')).run();
		const e = thrown(() => db.insert(users).values(user('u1', 'other@example.test')).run());
		expect(isUniqueViolation(e)).toBe(true);
		// Still wrapped, with the driver error reachable on the cause chain — the
		// shape errors.ts walks. If this changes, re-read errors.ts.
		expect((e as Error).cause).toBeDefined();
	});

	it('a duplicate UNIQUE-indexed value is recognised as a unique violation', () => {
		db.insert(users)
			.values([user('u1'), user('u2')])
			.run();
		const binding = (id: string, userId: string) => ({
			id,
			userId,
			provider: 'github',
			externalId: '42',
			createdAt: 1,
		});
		db.insert(oauthAccounts).values(binding('b1', 'u1')).run();
		const e = thrown(() => db.insert(oauthAccounts).values(binding('b2', 'u2')).run());
		expect(isUniqueViolation(e)).toBe(true);
	});

	it('a foreign-key or NOT NULL failure is not', () => {
		const fk = thrown(() =>
			db.insert(sessions).values({ id: 's', userId: 'missing', expiresAt: 1, createdAt: 1 }).run(),
		);
		const notNull = thrown(() =>
			db
				.insert(users)
				.values({
					...user('u3'),
					displayName: null as unknown as string,
					createdAt: null as unknown as number,
				})
				.run(),
		);
		expect(isUniqueViolation(fk)).toBe(false);
		expect(isUniqueViolation(notNull)).toBe(false);
	});
});

describe('transactions', () => {
	const ids = () =>
		db
			.select({ id: users.id })
			.from(users)
			.all()
			.map((r) => r.id)
			.sort();

	it('returns the callback’s value and commits', () => {
		const out = db.transaction((tx) => {
			tx.insert(users).values(user('a')).run();
			return 'done';
		});
		expect(out).toBe('done');
		expect(ids()).toEqual(['a']);
	});

	it('rolls back every write when the callback throws, and rethrows', () => {
		expect(() =>
			db.transaction((tx) => {
				tx.insert(users).values(user('a')).run();
				tx.update(users).set({ displayName: 'changed' }).where(eq(users.id, 'a')).run();
				throw new Error('boom');
			}),
		).toThrow('boom');
		expect(ids()).toEqual([]);
	});

	it('rolls back when a statement inside fails on a constraint', () => {
		db.insert(users).values(user('taken')).run();
		const e = thrown(() =>
			db.transaction((tx) => {
				tx.insert(users).values(user('fresh')).run();
				tx.insert(users).values(user('taken')).run();
			}),
		);
		expect(isUniqueViolation(e)).toBe(true);
		expect(ids()).toEqual(['taken']);
	});

	it('refuses a nested db.transaction() instead of promoting it to a savepoint', () => {
		// CLAUDE.md sharp edge: helpers that run inside a caller's transaction must
		// take its `tx`. If this starts succeeding, that guidance is stale.
		const e = thrown(() =>
			db.transaction((tx) => {
				tx.insert(users).values(user('outer')).run();
				db.transaction((inner) => inner.insert(users).values(user('inner')).run());
			}),
		);
		const cause = (e as Error).cause;
		const text = `${(e as Error).message} ${cause instanceof Error ? cause.message : ''}`;
		expect(text).toMatch(/within a transaction/i);
		expect(ids()).toEqual([]);
	});

	it('tx.transaction() is a savepoint: an inner failure rolls back only the inner writes', () => {
		db.transaction((tx) => {
			tx.insert(users).values(user('outer')).run();
			try {
				tx.transaction((sp) => {
					sp.insert(users).values(user('inner')).run();
					throw new Error('inner boom');
				});
			} catch {
				// swallowed: the outer transaction carries on
			}
			tx.insert(users).values(user('after')).run();
		});
		expect(ids()).toEqual(['after', 'outer']);
	});
});
