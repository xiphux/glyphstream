import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only the model call; keep approxTokens/chunkStrings real so the budgeting
// (one-shot vs iterative fold) is exercised for real.
const callMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/memory/summarize-util', async (orig) => ({
	...(await orig<typeof import('$lib/server/memory/summarize-util')>()),
	callMemoryModel: callMock,
}));

import { buildOverview, OVERVIEW_MAX_CHARS } from '$lib/server/memory/conversation-overview';

const MODEL = {
	endpoint: { id: 'gpu', maxConcurrent: 1 },
	upstreamId: 'm',
	maxTokens: 500,
	temperature: 0.2,
	activeHours: '',
	timezone: 'UTC',
} as unknown as Parameters<typeof buildOverview>[0];

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

	it('caps the overview at OVERVIEW_MAX_CHARS', async () => {
		callMock.mockResolvedValue('theme '.repeat(400)); // ~2400 chars
		const out = await buildOverview(MODEL, null, ['a', 'b'], 8000);
		expect(out.length).toBeLessThanOrEqual(OVERVIEW_MAX_CHARS);
		expect(out.endsWith('…')).toBe(true);
	});

	it('preserves newlines (structured map, not a single line)', async () => {
		const out = await buildOverview(MODEL, null, ['a'], 8000);
		expect(out).toContain('\n');
	});
});
