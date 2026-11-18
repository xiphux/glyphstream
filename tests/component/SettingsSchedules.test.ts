/**
 * /settings/schedules' row controls: the "On" checkbox shows what the server
 * stored, even when its request failed or another row's was in flight.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ScheduledTaskSummary } from '#lib/types/api.js';

vi.mock('$app/navigation', () => ({
	invalidate: vi.fn(async () => {}),
	refreshAll: vi.fn(async () => {}),
	goto: vi.fn(async () => {}),
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
}));
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, base: '', assets: '' }));

import SchedulesPage from '../../src/routes/(app)/settings/schedules/+page.svelte';

const settle = () => new Promise((r) => setTimeout(r, 20));

/** A fetch whose first call hangs until `release()`; later calls resolve at once. */
function stubFetch(result: { ok: boolean; status: number } = { ok: true, status: 200 }) {
	const urls: string[] = [];
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => (release = r));
	const response = {
		...result,
		statusText: '',
		headers: new Headers(),
		json: async () => ({}),
		text: async () => '',
		clone() {
			return this;
		},
	};
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			urls.push(String(url));
			if (urls.length === 1) await gate;
			return response as unknown as Response;
		}),
	);
	return { urls, release };
}

afterEach(() => vi.unstubAllGlobals());

const schedule = (id: string, name: string): ScheduledTaskSummary => ({
	id,
	name,
	prompt: 'p',
	modelId: 'bridge::gpt-4o',
	customModelId: null,
	systemPrompt: null,
	parameters: null,
	cadence: { kind: 'daily', time: '07:00', days: [1, 2, 3, 4, 5] },
	timezone: 'UTC',
	toolPolicy: { allowed: [], ask: [], memoryWrites: false },
	disabledFeatures: [],
	deadlineMinutes: 60,
	enabled: false,
	nextRunAt: null,
	consecutiveFailures: 0,
	disabledReason: null,
	createdAt: 0,
	updatedAt: 0,
	lastRun: null,
});
const data = {
	schedules: [schedule('a', 'Brief'), schedule('b', 'Inbox')],
	models: [],
	unlistedEndpoints: [],
	customModels: [],
	favoriteModels: [],
	servers: [],
	defaultTimezone: 'UTC',
	defaultDeadlineMinutes: 60,
	minIntervalHours: 1,
};

describe('/settings/schedules — On checkbox', () => {
	it("doesn't show a second schedule as on while another row's request is in flight", async () => {
		const user = userEvent.setup();
		const { urls, release } = stubFetch();
		const { rerender } = render(SchedulesPage, { props: { data: data as never } });
		const boxes = screen.getAllByRole('checkbox', { name: 'On' }) as HTMLInputElement[];

		await user.click(boxes[0]);
		await user.click(boxes[1]);
		release();
		await settle();
		// What `invalidate('settings:schedules')` then delivers: only `a` is on.
		const fresh = structuredClone(data);
		fresh.schedules[0].enabled = true;
		fresh.schedules[0].nextRunAt = 1_800_000_000_000;
		await rerender({ data: fresh as never });
		await settle();

		expect(screen.getAllByRole('checkbox', { name: 'On' })[1]).toBe(boxes[1]);
		expect(urls.some((u) => u.endsWith('/schedules/b'))).toBe(false);
		expect(boxes[1].checked).toBe(false);
	});

	it('puts the checkbox back when turning a schedule on fails', async () => {
		const user = userEvent.setup();
		const { release } = stubFetch({ ok: false, status: 500 });
		release();
		render(SchedulesPage, { props: { data: data as never } });
		const boxes = screen.getAllByRole('checkbox', { name: 'On' }) as HTMLInputElement[];

		await user.click(boxes[0]);
		await settle();

		expect(boxes[0].checked).toBe(false);
	});
});
