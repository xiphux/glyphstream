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
		expect(btn.textContent).toContain('Split per image');
		await user.click(btn);
		await tick();
		expect(btn.getAttribute('aria-pressed')).toBe('true');
	});

	it('shows the cross-product generation count when enabled', () => {
		// 3 images × 2 models = 6 generations.
		render(SplitAttachmentsToggle, {
			props: { enabled: true, imageCount: 3, modelCount: 2 },
		});
		expect(screen.getByRole('button').textContent).toContain('6 generations');
	});

	it('singular grammar for a single generation', () => {
		render(SplitAttachmentsToggle, { props: { enabled: true, imageCount: 1, modelCount: 1 } });
		expect(screen.getByRole('button').textContent).toContain('1 generation');
		expect(screen.getByRole('button').textContent).not.toContain('generations');
	});
});
