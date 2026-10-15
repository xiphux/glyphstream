/**
 * The end of a successful generation. The slot must be free before the title
 * race starts: the title task waits on the same endpoint gate, so on a
 * single-slot endpoint a slot held across the race would starve it.
 */
import { describe, expect, it, vi } from 'vitest';
import { settleGeneration } from '#lib/server/streaming/settle-generation.js';

describe('settleGeneration', () => {
	it('releases the slot and settles before it starts waiting on the title', async () => {
		const order: string[] = [];
		let resolveTitle!: (t: string) => void;
		const titlePromise = new Promise<string | null>((r) => (resolveTitle = r));
		const done = settleGeneration({
			releaseSlot: () => order.push('release'),
			onSettled: () => order.push('settle'),
			titlePromise,
			titleBudgetMs: 1_000,
			writeTitle: (ev) => order.push(`title:${ev.title}`),
		});
		// Both happened synchronously, while the title is still outstanding.
		expect(order).toEqual(['release', 'settle']);
		resolveTitle('Trip to Kyoto');
		await done;
		expect(order).toEqual(['release', 'settle', 'title:Trip to Kyoto']);
	});

	it('writes nothing when the title misses its budget, or when there is no title task', async () => {
		vi.useFakeTimers();
		try {
			const writeTitle = vi.fn();
			const late = settleGeneration({
				releaseSlot: () => {},
				titlePromise: new Promise(() => {}),
				titleBudgetMs: 50,
				writeTitle,
			});
			await vi.advanceTimersByTimeAsync(60);
			await late;
			await settleGeneration({
				releaseSlot: () => {},
				titlePromise: null,
				titleBudgetMs: 50,
				writeTitle,
			});
			expect(writeTitle).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
