/* @vitest-environment happy-dom */

/**
 * Pins ToolBlockShell's open-state contract, which is subtler than it looks:
 * `isOpen` drives the `<details>` two-way (`bind:open`, so a user toggle writes
 * back) AND gates the lazy body, while ALSO re-syncing to `openByDefault`
 * whenever `status` changes (executing → done auto-collapses).
 *
 * The three behaviors that pull against each other:
 *   1. status decides the initial + subsequent open state,
 *   2. a user toggle must survive re-renders while status is STABLE,
 *   3. a later status change must still win over that toggle.
 *
 * Written to settle whether the `$state(untrack(...)) + $effect` implementation
 * can be the writable `$derived` that `svelte/prefer-writable-derived`
 * suggests. It asserts observable behavior only — no implementation detail —
 * so it passes against either form and fails if they actually differ.
 */

import { describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render } from '@testing-library/svelte';
import ToolCallBlock from '$lib/components/ToolCallBlock.svelte';

function isOpen(container: HTMLElement): boolean {
	return container.querySelector('details')!.open;
}

/** Simulate a real user disclosure toggle: the browser flips `.open`, then fires `toggle`. */
async function userToggle(container: HTMLElement, next: boolean) {
	const d = container.querySelector('details')!;
	d.open = next;
	d.dispatchEvent(new Event('toggle'));
	await tick();
}

const base = { toolName: 'get_current_time', argumentsJson: '{}' } as const;

describe('ToolBlockShell — open state follows status', () => {
	it('starts open while executing', () => {
		const { container } = render(ToolCallBlock, { props: { ...base, status: 'executing' } });
		expect(isOpen(container)).toBe(true);
	});

	it('starts open on error', () => {
		const { container } = render(ToolCallBlock, { props: { ...base, status: 'error' } });
		expect(isOpen(container)).toBe(true);
	});

	it('starts open while awaiting approval', () => {
		const { container } = render(ToolCallBlock, {
			props: { ...base, status: 'pending_approval' },
		});
		expect(isOpen(container)).toBe(true);
	});

	it('starts collapsed when already done', () => {
		const { container } = render(ToolCallBlock, { props: { ...base, status: 'done' } });
		expect(isOpen(container)).toBe(false);
	});

	it('auto-collapses when status goes executing → done', async () => {
		const { container, rerender } = render(ToolCallBlock, {
			props: { ...base, status: 'executing' },
		});
		expect(isOpen(container)).toBe(true);
		await rerender({ ...base, status: 'done' });
		await tick();
		expect(isOpen(container)).toBe(false);
	});

	it('re-opens when status goes done → error', async () => {
		const { container, rerender } = render(ToolCallBlock, { props: { ...base, status: 'done' } });
		expect(isOpen(container)).toBe(false);
		await rerender({ ...base, status: 'error' });
		await tick();
		expect(isOpen(container)).toBe(true);
	});
});

describe('ToolBlockShell — user toggles vs. status sync', () => {
	it('a user expanding a done block stays expanded', async () => {
		const { container } = render(ToolCallBlock, { props: { ...base, status: 'done' } });
		await userToggle(container, true);
		expect(isOpen(container)).toBe(true);
	});

	it('a user collapsing an executing block stays collapsed', async () => {
		const { container } = render(ToolCallBlock, { props: { ...base, status: 'executing' } });
		await userToggle(container, false);
		expect(isOpen(container)).toBe(false);
	});

	// The load-bearing one: a re-render that does NOT change status must not
	// clobber the toggle back to openByDefault.
	it('survives a re-render that leaves status unchanged', async () => {
		const { container, rerender } = render(ToolCallBlock, {
			props: { ...base, status: 'done' },
		});
		await userToggle(container, true);
		await rerender({ ...base, status: 'done', argumentsJson: '{"tz":"UTC"}' });
		await tick();
		expect(isOpen(container)).toBe(true);
	});

	// ...but a genuine status change still wins over the user's toggle.
	it('a later status change overrides the user toggle', async () => {
		const { container, rerender } = render(ToolCallBlock, {
			props: { ...base, status: 'done' },
		});
		await userToggle(container, true);
		await rerender({ ...base, status: 'executing' });
		await tick();
		expect(isOpen(container)).toBe(true);
		await rerender({ ...base, status: 'done' });
		await tick();
		expect(isOpen(container)).toBe(false);
	});
});
