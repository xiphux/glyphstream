/* @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ScrollToBottomButton from '$lib/components/chat/ScrollToBottomButton.svelte';

describe('ScrollToBottomButton', () => {
	it('is opaque + tabbable + not aria-hidden when visible', () => {
		const { container } = render(ScrollToBottomButton, {
			props: { visible: true, onClick: vi.fn() }
		});
		expect(container.querySelector('.opacity-100')).toBeInTheDocument();
		const btn = screen.getByRole('button', { name: 'Scroll to latest message' });
		expect(btn).toHaveAttribute('aria-hidden', 'false');
		expect(btn).toHaveAttribute('tabindex', '0');
	});

	it('is transparent + untabbable + aria-hidden when not visible', () => {
		const { container } = render(ScrollToBottomButton, {
			props: { visible: false, onClick: vi.fn() }
		});
		expect(container.querySelector('.opacity-0')).toBeInTheDocument();
		// aria-hidden=true removes it from the a11y tree, so query the DOM.
		const btn = container.querySelector('button')!;
		expect(btn).toHaveAttribute('aria-hidden', 'true');
		expect(btn).toHaveAttribute('tabindex', '-1');
	});

	it('calls onClick when clicked', async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		render(ScrollToBottomButton, { props: { visible: true, onClick } });
		await user.click(screen.getByRole('button', { name: 'Scroll to latest message' }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});
