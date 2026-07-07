import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, type Page } from '@playwright/test';
import { TEST_USER } from './global-setup';

/**
 * Shared actions for the flow specs. The pattern throughout: bootstrap a
 * conversation by *actually using the app* (sending through the mock
 * upstream) rather than seeding the DB directly — keeps the tests fully
 * black-box and exercises the real create→navigate→stream round-trip that
 * the flows depend on.
 */

/** The deterministic reply tests/e2e/fixtures/mock-upstream.mjs streams. */
export const MOCK_REPLY = 'Hello from the mock upstream.';

/** Path the webServer opens (playwright.config.ts DB_PATH), resolved from
 *  the project root Playwright runs in. */
const DB_PATH = resolve('./tests/.e2e-data/test.db');

/**
 * Reset the DB to its seeded baseline: clear all conversation + media data
 * but keep the test user + session (so storageState stays valid). Called
 * in a beforeEach so every test — empty-state shell tests and stateful
 * flows alike — starts from a clean slate.
 *
 * Why this exists: there's ONE webServer (and one SQLite file) shared by
 * both the desktop and mobile projects, and global-setup only wipes once.
 * Without a per-test reset, a flow's conversation/media leaks into a later
 * test (even across projects) and breaks "renders empty state" assertions
 * or produces duplicate-title matches. A separate node:sqlite
 * connection writing between tests is safe here: workers=1, so no server
 * request is in flight at reset time, and busy_timeout covers WAL
 * contention. Deletes run children-first to satisfy FK constraints.
 */
export function resetData(): void {
	const db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec('PRAGMA foreign_keys = ON');
	try {
		// Null the conversation→message pointers first. active_leaf_message_id is
		// ON DELETE SET NULL, but fanout_parent_message_id (ALTER-added) is NO
		// ACTION — so a left-behind PARKED fan-out (the user never picked a branch)
		// would block `DELETE FROM messages` with an FK error and wedge every
		// subsequent test's reset. Clearing both up front makes reset robust.
		db.prepare(
			`UPDATE conversations SET active_leaf_message_id = NULL, fanout_parent_message_id = NULL`,
		).run();
		for (const table of [
			'message_media',
			'messages',
			'media',
			'conversations',
			'custom_models',
			// `memories` has no incoming FKs and its user_id cascades from the kept
			// user, so order is irrelevant — but it MUST be cleared, or a tombstone
			// seeded by the settings/memories specs (seedMemory) leaks into a sibling
			// test's deterministic list assertions.
			'memories',
		]) {
			db.prepare(`DELETE FROM ${table}`).run();
		}
	} finally {
		db.close();
	}
}

/**
 * Bulk-seed `count` generated image rows for the test user, straight into
 * the DB. The gallery paginates at page-size 60, so exercising infinite
 * scroll needs more rows than any happy-path flow would realistically
 * generate through the app — seeding directly is the only practical way to
 * cross several pages. We don't write any bytes to disk: the gallery grid
 * only renders <img> tags pointing at /api/media/<id>/thumbnail, and a
 * broken thumbnail still produces the DOM node the scroll assertions count.
 *
 * Rows are dated with strictly-descending createdAt (newest = i 0) so the
 * keyset cursor (createdAt:id, DESC) paginates deterministically with no
 * same-millisecond ties. origin='generated' + kind='image' so they pass
 * listMediaForUser's gallery filter. Mirrors resetData's standalone
 * node:sqlite connection — safe because workers=1 means no request is in
 * flight at seed time.
 */
export function seedMedia(count: number): void {
	const db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec('PRAGMA foreign_keys = ON');
	try {
		const stmt = db.prepare(
			`INSERT INTO media
			   (id, user_id, storage_path, content_type, byte_size, kind, origin,
			    prompt_excerpt, prompt_full, created_at, ref_count)
			 VALUES (?, ?, ?, ?, ?, 'image', 'generated', ?, ?, ?, 1)`,
		);
		const base = 1_700_000_000_000;
		for (let i = 0; i < count; i++) {
			const id = `e2e-media-${String(i).padStart(4, '0')}`;
			const prompt = `Seeded gallery image ${i}`;
			stmt.run(id, TEST_USER.id, `e2e/${id}.png`, 'image/png', 1024, prompt, prompt, base - i);
		}
	} finally {
		db.close();
	}
}

/**
 * Insert a bare conversation row straight into the DB, returning its id.
 * Emulates a conversation created on *another* client — one the server has
 * but the current page's SSR sidebar data never saw. The app's
 * create→navigate flow always runs on the client under test, so it can't
 * reproduce "a sibling client added a row this sidebar doesn't know about";
 * a direct insert (same approach as seedMedia) is the only way. Only the
 * columns listConversations reads need to be real; the distinctive title
 * makes the row assertable in Recents. Safe standalone connection for the
 * same reason as resetData/seedMedia — workers=1, no request in flight.
 */
export function seedConversation(title: string): string {
	const db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec('PRAGMA foreign_keys = ON');
	try {
		const id = `e2e-conv-${title.replace(/\W+/g, '-').toLowerCase()}`;
		const now = Date.now();
		db.prepare(
			`INSERT INTO conversations
			   (id, user_id, title, title_source, endpoint_id, model_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'fallback', 'mock', 'mock::mock-chat', ?, ?)`,
		).run(id, TEST_USER.id, title, now, now);
		return id;
	} finally {
		db.close();
	}
}

/**
 * Insert a memory row straight into the DB for the settings/memories specs.
 * Defaults to a live row; pass `deletedAt` (and optionally `supersededByMemoryId`)
 * to seed a dreaming-pass *tombstone* — the post-consolidation state the recover
 * UI surfaces. The app only reaches that state by running the LLM-backed,
 * window-gated dreaming pass, so seeding the tombstone directly is the only way
 * to test the recover UI deterministically. `superseded_by_memory_id` is a soft
 * self-reference (no FK), so a survivor row need not exist — but seed one if you
 * want the "Merged into…" lineage to render its snippet. Safe standalone
 * connection for the same reason as resetData/seedConversation — workers=1, no
 * request in flight.
 */
export function seedMemory(opts: {
	id: string;
	content: string;
	topic?: string | null;
	deletedAt?: number | null;
	supersededByMemoryId?: string | null;
	createdAt?: number;
	updatedAt?: number;
}): string {
	const db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec('PRAGMA foreign_keys = ON');
	try {
		const now = Date.now();
		db.prepare(
			`INSERT INTO memories
			   (id, user_id, content, topic, embedding, embedding_model,
			    recall_count, last_recalled_at, deleted_at, superseded_by_memory_id,
			    created_at, updated_at)
			 VALUES (?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, ?, ?)`,
		).run(
			opts.id,
			TEST_USER.id,
			opts.content,
			opts.topic ?? null,
			opts.deletedAt ?? null,
			opts.supersededByMemoryId ?? null,
			opts.createdAt ?? now,
			opts.updatedAt ?? now,
		);
		return opts.id;
	} finally {
		db.close();
	}
}

/**
 * Seed generated image rows grouped into explicit time buckets, for the
 * date-grouping / timeline-rail specs. Each bucket inserts `count` rows
 * clustered at `createdAt` (spread back 1ms each so the keyset cursor is
 * tie-free and the rows stay within the bucket's day). Pass buckets
 * newest-first. Like `seedMedia`, writes no bytes — the grid only needs the
 * <img>/heading DOM nodes. Use mid-month, clearly-past dates so local-tz
 * bucketing can't shift the month and "Today"/"Yesterday" never apply.
 */
export function seedMediaInBuckets(buckets: { createdAt: number; count: number }[]): void {
	const db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec('PRAGMA foreign_keys = ON');
	try {
		const stmt = db.prepare(
			`INSERT INTO media
			   (id, user_id, storage_path, content_type, byte_size, kind, origin,
			    prompt_excerpt, prompt_full, created_at, ref_count)
			 VALUES (?, ?, ?, ?, ?, 'image', 'generated', ?, ?, ?, 1)`,
		);
		let n = 0;
		for (const b of buckets) {
			for (let i = 0; i < b.count; i++) {
				const id = `e2e-media-${String(n).padStart(4, '0')}`;
				const prompt = `Seeded ${id}`;
				stmt.run(
					id,
					TEST_USER.id,
					`e2e/${id}.png`,
					'image/png',
					1024,
					prompt,
					prompt,
					b.createdAt - i,
				);
				n++;
			}
		}
	} finally {
		db.close();
	}
}

/**
 * Seed one generated image per given prompt string (newest = first), for the
 * prompt-search specs. The prompt is stored in both `prompt_full` (what search
 * indexes) and `prompt_excerpt` (the tile caption). Like the other seeders,
 * writes no bytes — the grid only needs the heading/<img> DOM nodes.
 */
export function seedMediaPrompts(prompts: string[]): void {
	const db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec('PRAGMA foreign_keys = ON');
	try {
		const stmt = db.prepare(
			`INSERT INTO media
			   (id, user_id, storage_path, content_type, byte_size, kind, origin,
			    prompt_excerpt, prompt_full, created_at, ref_count)
			 VALUES (?, ?, ?, ?, ?, 'image', 'generated', ?, ?, ?, 1)`,
		);
		const base = 1_700_000_000_000;
		prompts.forEach((p, i) => {
			const id = `e2e-media-${String(i).padStart(4, '0')}`;
			stmt.run(id, TEST_USER.id, `e2e/${id}.png`, 'image/png', 1024, p, p, base - i);
		});
	} finally {
		db.close();
	}
}

/**
 * Open the model picker and pick a model by visible name. Works for both
 * the inline (composer) and full-width picker variants — the trigger's
 * aria-label is "Select model" in both.
 */
export async function selectModel(page: Page, name: string | RegExp): Promise<void> {
	await page.getByRole('button', { name: 'Select model' }).click();
	await page.getByRole('option', { name }).click();
}

/**
 * Enable (or disable) auto-compaction for the test user by writing the
 * preferences JSON blob directly — the defensive parser fills the rest, and the
 * page's load reads it, so call this BEFORE navigating. Mirrors resetData's
 * standalone node:sqlite connection (safe under workers=1).
 */
export function setAutoCompaction(enabled: boolean, thresholdPct: number): void {
	const db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA busy_timeout = 5000');
	try {
		const prefs = JSON.stringify({
			autoCompactionEnabled: enabled,
			autoCompactionThreshold: thresholdPct,
		});
		db.prepare(`UPDATE users SET preferences_json = ? WHERE id = ?`).run(prefs, TEST_USER.id);
	} finally {
		db.close();
	}
}

/**
 * Send a follow-up message in an already-open chat and wait for the turn to
 * settle. Counts real message bubbles (`#msg-*`, which excludes the compaction
 * summary divider) and waits for the user+assistant pair to land + the composer
 * to flip Stop → Send.
 */
export async function sendFollowup(page: Page, text: string): Promise<void> {
	const bubbles = page.locator('[id^="msg-"]');
	const before = await bubbles.count();
	await page.locator('textarea').first().fill(text);
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();
	await expect(bubbles).toHaveCount(before + 2);
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
}

/** Mobile starts with the sidebar behind a hamburger; desktop is static.
 *  No-op on desktop. */
export async function openSidebar(page: Page, isMobile: boolean): Promise<void> {
	if (isMobile) {
		await page.getByRole('button', { name: 'Open menu' }).click();
	}
}

/**
 * Send `prompt` from the new-chat home page with the default (chat) model,
 * wait for the navigation to /chat/[id] and the streamed reply to render.
 * Returns the new conversation id.
 */
export async function sendChatFromHome(page: Page, prompt: string): Promise<string> {
	await page.goto('/');
	// Gate on hydration + the default-model effect: once the picker shows
	// "Mock Chat" the page is interactive and a model is selected, so the
	// Send button can enable.
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
	await page.locator('textarea').first().fill(prompt);
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.getByText(MOCK_REPLY)).toBeVisible();
	// Wait for the turn to fully settle (composer flips Stop → Send). The
	// relay emits `done` — which clears `generating` — only after its
	// background recorder has persisted the assistant row, so this gates on
	// the write completing. Without it, the next test's resetData() can
	// delete the conversation while that recorder is still inserting,
	// tripping a FK-constraint error server-side.
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
	return page.url().split('/chat/')[1];
}

/**
 * Generate an image from the home page: switch to the image model, send
 * `prompt`, wait for the navigation + the generated image to render.
 * Returns the conversation id.
 */
export async function generateImageFromHome(page: Page, prompt: string): Promise<string> {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
	await selectModel(page, /Mock Image/);
	await page.locator('textarea').first().fill(prompt);
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	// The generated asset renders as an <img> pointing at our media route.
	await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
	return page.url().split('/chat/')[1];
}
