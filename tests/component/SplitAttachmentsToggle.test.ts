/* @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import SplitAttachmentsToggle from '$lib/components/chat/SplitAttachmentsToggle.svelte';

describe('SplitAttachmentsToggle', () => {
	it('toggles enabled on click and reflects aria-pressed', async () => {
		const user = userEvent.setup();
		render(SplitAttachmentsToggle, {
			props: { enabled: false, imageCount: 4, modelCount: 1 },
		});
		const btn = screen.getByRole('button');
		expect(btn.getAttribute('aria-pressed')).toBe('false');
		expect(btn.textContent).toContain('Split'); // compact label when off
		await user.click(btn);
		await tick();
		expect(btn.getAttribute('aria-pressed')).toBe('true');
	});

	it('shows the compact cross-product count (×N) when enabled', () => {
		// 3 images × 2 models = ×6.
		render(SplitAttachmentsToggle, {
			props: { enabled: true, imageCount: 3, modelCount: 2 },
		});
		const btn = screen.getByRole('button');
		expect(btn.textContent).toContain('×6');
		// The wordy caption lives in the popover now, not on the button itself.
		expect(btn.textContent).not.toContain('generations');
		expect(btn.textContent).not.toContain('per image');
	});

	it('carries a clarifying popover (in the DOM, revealed on hover)', () => {
		const single = render(SplitAttachmentsToggle, {
			props: { enabled: false, imageCount: 4, modelCount: 1 },
		});
		expect(single.container.textContent).toContain('Split per image');
		expect(single.container.textContent).toContain('Runs the prompt on each image separately');

		// With multiple models the popover spells out the cross product.
		const cross = render(SplitAttachmentsToggle, {
			props: { enabled: true, imageCount: 3, modelCount: 2 },
		});
		expect(cross.container.textContent).toContain('3 images × 2 models = 6 generations');
	});
});
