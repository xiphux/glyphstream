import { test, expect } from '@playwright/test';

/**
 * `idle` reports how long the server went without serving a request, and the
 * only thing that makes it useful is what does NOT count as a request.
 *
 * It shipped capped at 30 seconds. The Dockerfile bakes in a HEALTHCHECK that
 * polls `/api/health` every 30s, and unlike a static asset — which sirv answers
 * ahead of the SSR handler — a dynamic route reaches the hook and reset the
 * clock. The field kept rendering a plausible number that could never be the
 * real one, and the docs told the operator to read a small number as "the server
 * was busy". Nothing failed; the diagnostic just quietly lied.
 *
 * So this asserts the exemption end to end rather than trusting the branch to
 * stay correct: a probe between two documents must not shorten the gap the
 * second one reports.
 */
function idleMs(serverTiming: string | undefined): number | null {
	const found = /(?:^|,)\s*idle;dur=([\d.]+)/.exec(serverTiming ?? '');
	return found ? Number(found[1]) : null;
}

const GAP_MS = 1_200;
/** Generous margin: the bug drives this to ~0, so anything near the real gap
 *  proves the exemption held without making the assertion clock-sensitive. */
const MIN_REPORTED_MS = 1_000;

test('the container health probe does not count as activity', async ({ request }) => {
	// Establish a known "last request", then leave a measurable gap.
	await request.get('/');
	await new Promise((resolve) => setTimeout(resolve, GAP_MS));

	// Exactly what the Dockerfile's HEALTHCHECK does, twice, mid-gap.
	expect((await request.get('/api/health')).status()).toBe(200);
	expect((await request.get('/api/health')).status()).toBe(200);

	const res = await request.get('/');
	const idle = idleMs(res.headers()['server-timing']);
	expect(idle, 'no idle field in Server-Timing').not.toBeNull();
	expect(idle!, `idle reported ${idle}ms across a ${GAP_MS}ms gap`).toBeGreaterThan(
		MIN_REPORTED_MS,
	);
});

test('an ordinary request does count as activity', async ({ request }) => {
	// The other half of the contract — the exemption must be specific to the
	// probe, not a blanket "API calls do not count", or the metric measures
	// nothing at all.
	await request.get('/');
	await new Promise((resolve) => setTimeout(resolve, GAP_MS));
	await request.get('/');

	const res = await request.get('/');
	const idle = idleMs(res.headers()['server-timing']);
	expect(idle).not.toBeNull();
	expect(idle!, `idle reported ${idle}ms right after a real request`).toBeLessThan(MIN_REPORTED_MS);
});
