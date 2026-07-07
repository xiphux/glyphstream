import { test, expect } from '@playwright/test';
import { resetData, seedMemory } from './helpers';

/**
 * Settings → Memories management. These specs cover the two flows that only
 * exist as a real load → real endpoint → real reload round-trip — the seam the
 * unit tests (query layer, direct DB) and component tests (mocked fetch +
 * hand-rendered ConfirmDialog) structurally can't reach:
 *
 *   - Forgetting a live memory: the confirm host lives once in the (app)
 *     layout, and the DELETE is a hard delete. The component test stubs both;
 *     here the real dialog + real endpoint + reload run end-to-end.
 *   - Restoring a dreaming-tombstoned memory back into the live list — the
 *     recover UI's whole reason to exist, proven against the real restore
 *     endpoint and the invalidate → re-load that moves the row between lists.
 *
 * The tombstone state is seeded directly (seedMemory({ deletedAt })) rather than
 * by running the dreaming pass: that pass is LLM-backed and quiet-hours-gated, so
 * reproducing it in a browser would be slow and nondeterministic — and the
 * recover UI only cares about the post-consolidation rows, not how they got there.
 *
 * Clean slate per test for the one-DB-across-projects reason (see
 * helpers.resetData) — which now also clears the memories table, so a sibling
 * test's rows can't skew these deterministic list assertions.
 */

test.beforeEach(() => resetData());

test.describe('settings/memories: forget a live memory', () => {
	test('confirming Forget hard-deletes the row and returns the empty state', async ({ page }) => {
		seedMemory({ id: 'e2e-mem-live', content: 'prefers metric units', topic: 'Units' });
		await page.goto('/settings/memories');

		const row = page.getByText('prefers metric units');
		await expect(row).toBeVisible();

		// The trash affordance is hover-revealed (opacity-0) but still clickable —
		// opacity doesn't gate Playwright actionability or pointer events.
		await page.getByRole('button', { name: 'Forget memory' }).click();

		// A real <ConfirmDialog> from the (app) layout host — not a per-page render.
		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText('prefers metric units')).toBeVisible();
		await dialog.getByRole('button', { name: 'Forget' }).click();

		// Hard delete + invalidate reload → row gone, empty state back.
		await expect(row).toHaveCount(0);
		await expect(page.getByText(/No memories saved yet/)).toBeVisible();
	});
});

test.describe('settings/memories: restore a tidied memory', () => {
	test('restoring moves the row from "Recently tidied" back into the live list', async ({
		page,
	}) => {
		// The dreaming merge shape: a live survivor + a tombstone folded into it.
		seedMemory({
			id: 'e2e-mem-survivor',
			content: 'now at Globex; previously at Acme',
			topic: 'Employer',
		});
		seedMemory({
			id: 'e2e-mem-dead',
			content: 'works at Acme',
			topic: 'Employer',
			deletedAt: Date.now() - 60_000,
			supersededByMemoryId: 'e2e-mem-survivor',
		});
		await page.goto('/settings/memories');

		// The survivor is live; the tombstone is not in the live list. Exact match:
		// the merge lineage line below ("Merged into: now at Globex…") also contains
		// this snippet, so a substring match would be ambiguous in strict mode.
		await expect(
			page.getByText('now at Globex; previously at Acme', { exact: true }),
		).toBeVisible();
		const tidied = page.locator('details', { hasText: 'Recently tidied' });
		await expect(tidied).toBeVisible();

		// Expand the collapsed section; the tombstone body + merge lineage render.
		await tidied.getByText(/Recently tidied \(1\)/).click();
		await expect(tidied.getByText('works at Acme')).toBeVisible();
		await expect(tidied.getByText(/Merged into: now at Globex/)).toBeVisible();

		// Restore is non-destructive — it fires straight off, no confirm dialog.
		await tidied.getByRole('button', { name: 'Restore memory' }).click();
		await expect(page.getByRole('alertdialog')).toHaveCount(0);

		// Round-trip: the only tombstone is gone, so the whole "Recently tidied"
		// section unmounts, and the restored row now shows in the live list.
		await expect(page.locator('details', { hasText: 'Recently tidied' })).toHaveCount(0);
		await expect(page.getByText('works at Acme', { exact: true })).toBeVisible();
	});
});
