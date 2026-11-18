/**
 * Holds the line on the root error page healing itself after a transient
 * failure.
 *
 * Kit swaps the whole app for this page whenever a layout load fails, and a
 * background `invalidate()` whose `__data.json` dies (the container restarting
 * under a refocus, an iOS resume before the radio is back) is exactly that.
 * Waiting for a Reload tap loses nothing the next load wouldn't restore, so
 * the page re-runs the loads itself: on `online`, on either half of an app
 * resume (`visibilitychange`, persisted `pageshow`), and on a capped backoff —
 * never while hidden, and never for a 4xx, which is a real answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

const refreshAll = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$app/navigation', () => ({ refreshAll }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$app/state', async () => {
	const { createKitStub } = await import('./_helpers/kit-runtime-stub.svelte');
	holder.current = createKitStub('http://localhost:3000/');
	return { page: holder.current.page, navigating: holder.current.navigating };
});

import RootError from '../../src/routes/+error.svelte';

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
	visibility = next;
	document.dispatchEvent(new Event('visibilitychange'));
}

/** `pageshow` with a real `persisted` flag — happy-dom has no PageTransitionEvent. */
function pageShow(persisted: boolean): Event {
	const event = new Event('pageshow');
	Object.defineProperty(event, 'persisted', { value: persisted });
	return event;
}

function mount(status: number) {
	stub().page.status = status;
	stub().page.error = { message: status >= 500 ? 'Internal Error' : 'Not Found' };
	const result = render(RootError);
	flushSync();
	return result;
}

/** Advance fake time and let the awaited `refreshAll()` settle. */
async function advance(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
	stub().reset();
	refreshAll.mockClear();
	refreshAll.mockImplementation(async () => {});
	visibility = 'visible';
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => visibility,
	});
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('root error page — self-healing', () => {
	it('retries a 5xx on a capped backoff, saying so', async () => {
		mount(500);
		expect(screen.getByRole('status').textContent).toContain('Reconnecting');
		expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();

		await advance(1_999);
		expect(refreshAll).not.toHaveBeenCalled();
		await advance(1);
		expect(refreshAll).toHaveBeenCalledTimes(1);
		await advance(5_000);
		expect(refreshAll).toHaveBeenCalledTimes(2);
		await advance(15_000);
		expect(refreshAll).toHaveBeenCalledTimes(3);
		await advance(30_000);
		expect(refreshAll).toHaveBeenCalledTimes(4);
		await advance(29_999);
		expect(refreshAll).toHaveBeenCalledTimes(4);
		await advance(1);
		expect(refreshAll).toHaveBeenCalledTimes(5);
	});

	it('stops once the retry recovers', async () => {
		const { unmount } = mount(502);
		// Kit tears the error tree down when the load succeeds.
		refreshAll.mockImplementation(async () => {
			unmount();
		});
		await advance(2_000);
		expect(refreshAll).toHaveBeenCalledTimes(1);
		await advance(120_000);
		expect(refreshAll).toHaveBeenCalledTimes(1);
	});

	it('leaves a 4xx alone', async () => {
		mount(404);
		expect(screen.queryByRole('status')).toBeNull();
		window.dispatchEvent(new Event('online'));
		setVisibility('visible');
		await advance(120_000);
		expect(refreshAll).not.toHaveBeenCalled();
	});

	it('does not retry while hidden, and retries at once on becoming visible', async () => {
		mount(500);
		setVisibility('hidden');
		await advance(120_000);
		expect(refreshAll).not.toHaveBeenCalled();

		setVisibility('visible');
		await advance(0);
		expect(refreshAll).toHaveBeenCalledTimes(1);
	});

	it('retries at once on a persisted pageshow, not a fresh one', async () => {
		mount(500);
		window.dispatchEvent(pageShow(false));
		await advance(0);
		expect(refreshAll).not.toHaveBeenCalled();

		window.dispatchEvent(pageShow(true));
		await advance(0);
		expect(refreshAll).toHaveBeenCalledTimes(1);
	});

	it('retries at once when the connection comes back', async () => {
		mount(500);
		window.dispatchEvent(new Event('online'));
		await advance(0);
		expect(refreshAll).toHaveBeenCalledTimes(1);
	});

	it('runs one retry at a time', async () => {
		mount(500);
		let settle = () => {};
		refreshAll.mockImplementation(() => new Promise<void>((r) => (settle = r)));
		window.dispatchEvent(new Event('online'));
		window.dispatchEvent(new Event('online'));
		setVisibility('visible');
		await advance(60_000);
		expect(refreshAll).toHaveBeenCalledTimes(1);
		settle();
	});
});
