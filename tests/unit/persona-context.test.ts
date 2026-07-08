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
import { setConversationOverview } from '$lib/server/db/queries/users';
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

/** Push the store over the inline budget with topic-labelled rows, created
 *  oldest→newest with strictly increasing timestamps so tiering is deterministic:
 *  the freshest rows are hottest (inlined), the oldest overflow to the index.
 *  ~15 rows of ~310 chars ⇒ ~12 hot, ~3 cold against the 4000-char budget. */
async function seedOverBudget(userId: string) {
	const per = 300;
	const rows = Math.ceil(MEMORY_INLINE_BUDGET_CHARS / per) + 1;
	for (let i = 0; i < rows; i++) {
		createMemory(userId, `body-${i} ` + 'x'.repeat(per), `Topic ${i}`);
		await new Promise((r) => setTimeout(r, 2));
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

	it('over budget: inlines the hot (freshest) tier in full and indexes the cold tail', async () => {
		const u = seedUser();
		await seedOverBudget(u.id);
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		// The freshest memory is inlined in full...
		expect(out).toContain('body-14');
		// ...the oldest overflow to a topic-only index (topic shown, body absent)...
		expect(out).toContain('Topic 0');
		expect(out).not.toContain('body-0 ');
		// ...under the tiered header, which points at recall_memory for the tail.
		expect(out).toMatch(/shown in full/);
		expect(out).toMatch(/topic only/);
		expect(out).toMatch(/recall_memory/);
	});

	it('inlines a brand-new memory (freshness) even in an over-budget store', async () => {
		const u = seedUser();
		await seedOverBudget(u.id);
		await new Promise((r) => setTimeout(r, 2));
		createMemory(u.id, 'JUST_SAVED distinctive body', 'Brand new');
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		// The just-saved memory ranks top on freshness → inlined in full, not just its topic.
		expect(out).toContain('JUST_SAVED distinctive body');
	});

	it('renders the section without an embedding model configured (decoupled)', async () => {
		// composePersonaPrompt no longer consults the embeddings config; the budget
		// alone drives tiering. No embeddings mocked here — the section still renders.
		const u = seedUser();
		await seedOverBudget(u.id);
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		expect(out).toMatch(/recall_memory/);
		expect(out).toMatch(/shown in full/);
	});

	it('injects the conversation-topics overview when one is set', () => {
		const u = seedUser();
		setConversationOverview(u.id, '## Work\n- deploy pipeline', Date.now());
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		expect(out).toContain('deploy pipeline');
		expect(out).toContain('search_conversations'); // points the model at the tool
	});

	it('omits the overview section when none is set', () => {
		const u = seedUser();
		createMemory(u.id, 'a fact', 'Fact');
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		expect(out).not.toContain('search_conversations');
	});

	it('omits the overview when personalization is disabled', () => {
		const u = seedUser();
		setConversationOverview(u.id, 'topics map', Date.now());
		expect(composePersonaPrompt(PREFS, u.id, ['personalization'])).toBeNull();
	});

	it('falls back to a content snippet (not the full body) for a topic-less cold row', async () => {
		const u = seedUser();
		// Oldest row, no topic, long body → cold tail → index line shows the 80-char snippet.
		createMemory(u.id, 'legacy ' + 'y'.repeat(200));
		await new Promise((r) => setTimeout(r, 2));
		await seedOverBudget(u.id);
		const out = composePersonaPrompt(PREFS, u.id, [])!;
		expect(out).toContain('legacy ' + 'y'.repeat(73)); // 7 + 73 = the 80-char snippet
		expect(out).not.toContain('y'.repeat(200)); // the full body is NOT inlined
	});
});
