import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only the model call; keep approxTokens/chunkStrings real so the budgeting
// (one-shot vs iterative fold) is exercised for real.
const callMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/memory/summarize-util', async (orig) => ({
	...(await orig<typeof import('$lib/server/memory/summarize-util')>()),
	callMemoryModel: callMock,
}));

import { buildOverview } from '$lib/server/memory/conversation-overview';
import { EmptyCompletionError } from '$lib/server/memory/summarize-util';
import { DEFAULT_MEMORY_OVERVIEW_MAX_CHARS } from '$lib/server/endpoints/config';

type Model = Parameters<typeof buildOverview>[0];

const model = (overviewMaxChars = DEFAULT_MEMORY_OVERVIEW_MAX_CHARS) =>
	({
		endpoint: { id: 'gpu', maxConcurrent: 1 },
		upstreamId: 'm',
		maxTokens: 500,
		temperature: 0.2,
		activeHours: '',
		timezone: 'UTC',
		overviewMaxChars,
	}) as unknown as Model;

const MODEL = model();

beforeEach(() => {
	callMock.mockReset();
	callMock.mockResolvedValue('## Work\n- API deploys\n## Personal\n- Japan trip');
});

describe('buildOverview', () => {
	it('returns the previous overview unchanged when there are no summaries', async () => {
		expect(await buildOverview(MODEL, 'old map', [], 8000)).toBe('old map');
		expect(callMock).not.toHaveBeenCalled();
	});

	it('builds in one call when everything fits, passing the previous map as anchor', async () => {
		const out = await buildOverview(
			MODEL,
			'PRIOR MAP',
			['discussed deploys', 'planned a trip'],
			8000,
		);
		expect(callMock).toHaveBeenCalledTimes(1);
		expect(out).toContain('API deploys');
		// The previous map + the summaries are in the user content.
		const userContent = callMock.mock.calls[0][2] as string;
		expect(userContent).toContain('PRIOR MAP');
		expect(userContent).toContain('discussed deploys');
		expect(userContent).toContain('planned a trip');
	});

	it('iterative-folds when the summaries overflow the budget', async () => {
		// contextWindow=1000 → budget floors to 1000 tokens (~4000 chars). Eight
		// ~600-char summaries (~4800 chars) overflow → chunked fold, several calls.
		const summaries = Array.from({ length: 8 }, (_, i) => `summary ${i} ` + 'x'.repeat(580));
		await buildOverview(MODEL, null, summaries, 1000);
		expect(callMock.mock.calls.length).toBeGreaterThan(1);
	});

	it('fails the rebuild when a fold batch comes back empty, rather than cold-starting the map', async () => {
		// The fold assigns each call's result to `map`, so an empty one used to reset it:
		// the next batch would restart from "(none yet)" and the final map would silently
		// omit every topic from the earlier batches. That map is truthy, so it sailed past
		// the worker's empty-check and got stored — lossy, with the watermark stamped
		// behind it. An empty completion now throws (callMemoryModel), and the fold must
		// let it through so the worker skips the user and retries next sweep.
		const summaries = Array.from({ length: 8 }, (_, i) => `summary ${i} ` + 'x'.repeat(580));
		callMock
			.mockResolvedValueOnce('## Work\n- API deploys')
			.mockRejectedValueOnce(new EmptyCompletionError('gpu::m returned an empty completion'))
			.mockResolvedValue('## Personal\n- Japan trip');

		await expect(buildOverview(MODEL, null, summaries, 1000)).rejects.toThrow(EmptyCompletionError);
	});

	it("caps the overview at the model's overview_max_chars", async () => {
		callMock.mockResolvedValue('theme '.repeat(1000)); // ~6000 chars — well over any cap
		const out = await buildOverview(MODEL, null, ['a', 'b'], 8000);
		expect(out.length).toBeLessThanOrEqual(DEFAULT_MEMORY_OVERVIEW_MAX_CHARS);
		expect(out.endsWith('…')).toBe(true);
	});

	it('honors a configured overview_max_chars, in the cap AND in what it asks the model for', async () => {
		callMock.mockResolvedValue('theme '.repeat(1000));
		const out = await buildOverview(model(800), null, ['a', 'b'], 8000);

		expect(out.length).toBeLessThanOrEqual(800);
		// The model is told the same budget it will be held to — an LLM can't count
		// characters, so the cap is the backstop, not the mechanism.
		expect(callMock.mock.calls[0][1]).toContain('under 800 characters');
	});

	it('preserves newlines (structured map, not a single line)', async () => {
		const out = await buildOverview(MODEL, null, ['a'], 8000);
		expect(out).toContain('\n');
	});
});
