/**
 * The one-shot `seed` on the composer's aspect-ratio selector.
 *
 * A gallery "Regenerate with this prompt" seeds the picker with the original's
 * shape so the re-run reproduces its framing. The subtle part is that the seed
 * has to RETIRE the moment the user overrides it — and retire in the PARENT's
 * state, not the component's, because the composer destroys the selector
 * whenever no selected model offers ratios. A local "already picked" flag resets
 * on the remount, at which point a still-set seed silently reverts a choice the
 * user had already made. That remount sequence is what the last test walks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import AspectRatioSelector from '$lib/components/chat/AspectRatioSelector.svelte';
import Harness from './_helpers/AspectRatioSeedHarness.svelte';
import type { AspectRatioOption } from '$lib/types/api';

const OPTIONS: AspectRatioOption[] = [
	{ value: '1:1', label: 'Square' },
	{ value: '9:16', label: 'Portrait Widescreen' },
	{ value: '16:9', label: 'Widescreen' },
];

/** The trigger's accessible name carries the current selection. */
const trigger = () => screen.getByRole('button', { name: /^Aspect ratio/ });

async function pick(value: string) {
	const user = userEvent.setup();
	await user.click(trigger());
	await user.click(screen.getByRole('button', { name: new RegExp(`^${value}`) }));
}

describe('AspectRatioSelector — the one-shot seed', () => {
	beforeEach(() => {
		// The remembered preference outlives a component, so it has to be reset
		// between tests — a pick in one case would otherwise decide the next.
		localStorage.clear();
	});

	it('opens on the seed rather than the remembered preference', () => {
		localStorage.setItem('gs:aspect-ratio', '1:1');
		render(AspectRatioSelector, { props: { options: OPTIONS, seed: '16:9', value: null } });
		expect(trigger()).toHaveTextContent('16:9');
	});

	it('snaps a seed the model does not offer to the nearest it does', () => {
		// Same rule as a remembered preference: show what the user will GET, not
		// whatever we happen to be holding.
		render(AspectRatioSelector, {
			props: { options: [{ value: '1:1' }, { value: '16:9' }], seed: '21:9', value: null },
		});
		expect(trigger()).toHaveTextContent('16:9');
	});

	it('opens on the model default when there is no seed and no stored pick', () => {
		render(AspectRatioSelector, {
			props: { options: OPTIONS, seed: null, defaultValue: '9:16', value: null },
		});
		expect(trigger()).toHaveTextContent('9:16');
	});

	it('clears the seed in the parent when the user picks', async () => {
		const onSeedChange = vi.fn();
		render(Harness, { props: { options: OPTIONS, initialSeed: '16:9', onSeedChange } });
		expect(trigger()).toHaveTextContent('16:9');

		await pick('9:16');

		expect(onSeedChange).toHaveBeenLastCalledWith(null);
		expect(trigger()).toHaveTextContent('9:16');
	});

	it('reports the resolved value to the parent', async () => {
		const onValueChange = vi.fn();
		render(Harness, { props: { options: OPTIONS, onValueChange } });
		await pick('16:9');
		expect(onValueChange).toHaveBeenLastCalledWith('16:9');
	});

	it('does not revert a pick when the selector is destroyed and recreated', async () => {
		// The regression. Sequence: arrive from a gallery regenerate seeded 16:9,
		// pick 9:16, switch to a chat model (selector destroyed), switch back
		// (recreated). A seed held only in the child would come back and win.
		const { rerender } = render(Harness, {
			props: { options: OPTIONS, initialSeed: '16:9' },
		});
		await pick('9:16');
		expect(trigger()).toHaveTextContent('9:16');

		await rerender({ options: OPTIONS, initialSeed: '16:9', mounted: false });
		expect(screen.queryByRole('button', { name: /^Aspect ratio/ })).toBeNull();

		await rerender({ options: OPTIONS, initialSeed: '16:9', mounted: true });
		expect(trigger()).toHaveTextContent('9:16');
	});
});
