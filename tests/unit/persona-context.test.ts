import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import { composePersonaPrompt } from '$lib/server/chat/persona-context';
import { createMemory, MEMORY_INLINE_BUDGET_CHARS } from '$lib/server/db/queries/memories';
import type { UserPreferences } from '$lib/types/api';

const PREFS: UserPreferences = {
	name: '',
	aboutYou: '',
	customInstructions: '',
	enterBehavior: 'send',
	showGreeting: true,
	theme: 'glyphstream',
	colorScheme: 'system',
	notificationsEnabled: false,
	notificationsShowContent: false,
	notificationsForegroundToast: true,
	favoriteModels: [],
	modelSets: [],
	trustedMcpTools: [],
	autoCompactionEnabled: false,
	autoCompactionThreshold: 80,
};

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());

/** Push the store just over the inline budget with topic-labelled rows. */
function seedOverBudget(userId: string) {
	const per = 300;
	const rows = Math.ceil(MEMORY_INLINE_BUDGET_CHARS / per) + 1;
	for (let i = 0; i < rows; i++) {
		createMemory(userId, `body-${i} ` + 'x'.repeat(per), `Topic ${i}`);
	}
}

describe('composePersonaPrompt', () => {
	it('returns null when personalization is disabled', () => {
		const u = seedUser();
		createMemory(u.id, 'a fact', 'Fact');
		expect(composePersonaPrompt(PREFS, u.id, ['personalization'])).toBeNull();
	});

	it('inlines full bodies under budget', () => {
		const u = seedUser();
		createMemory(u.id, 'prefers metric units', 'Units');
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		expect(out).toContain('prefers metric units');
		expect(out).toMatch(/Saved memories/);
	});

	it('switches to the `[id] topic` index over budget (no bodies)', () => {
		const u = seedUser();
		seedOverBudget(u.id);
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		// Topics are shown...
		expect(out).toContain('Topic 0');
		expect(out).toMatch(/recall_memory/);
		// ...but the full bodies are not inlined.
		expect(out).not.toContain('x'.repeat(300));
	});

	it('enters index mode regardless of embeddings (recall-by-id needs none)', () => {
		// composePersonaPrompt no longer consults the embeddings config at all —
		// the budget alone drives the switch. This test documents that decoupling:
		// with no embeddings mocked, an over-budget store still indexes.
		const u = seedUser();
		seedOverBudget(u.id);
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		expect(out).toMatch(/Saved memory index/);
	});

	it('falls back to a content snippet for a topic-less row in the index', () => {
		const u = seedUser();
		seedOverBudget(u.id);
		// A legacy row with no topic — its index line should show the body snippet.
		createMemory(u.id, 'legacy fact without a topic label');
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		expect(out).toContain('legacy fact without a topic label');
	});
});
