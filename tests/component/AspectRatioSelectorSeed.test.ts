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
		localStorage.setItem('glyphstream:aspectRatio', '1:1');
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

	it('opens on Default when there is no seed and no stored pick', () => {
		// Not on the model's default as a concrete shape: "no preference" has to stay
		// expressible, because it is the only way to say "let each model decide".
		render(AspectRatioSelector, {
			props: { options: OPTIONS, seed: null, defaultValue: '9:16', value: null },
		});
		expect(trigger()).toHaveTextContent('Default');
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

describe('AspectRatioSelector — the Default entry', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	const defaultRow = () => screen.getByRole('button', { name: /^Default/ });

	it('reports null upward, so the send omits the field entirely', async () => {
		// Null is what makes "each model uses its own" expressible; any concrete
		// value would be imposed on every fan-out branch.
		const onValueChange = vi.fn();
		render(Harness, { props: { options: OPTIONS, onValueChange } });
		await pick('16:9');
		expect(onValueChange).toHaveBeenLastCalledWith('16:9');

		const user = userEvent.setup();
		await user.click(trigger());
		await user.click(defaultRow());
		expect(onValueChange).toHaveBeenLastCalledWith(null);
	});

	it('is reachable again after picking a shape — the gap this closed', async () => {
		// Before Default existed, a stored preference made the workflow's own shape
		// permanently unreachable: every render forced a concrete value.
		render(AspectRatioSelector, { props: { options: OPTIONS, value: null } });
		await pick('16:9');
		expect(trigger()).toHaveTextContent('16:9');

		const user = userEvent.setup();
		await user.click(trigger());
		await user.click(defaultRow());
		expect(trigger()).toHaveTextContent('Default');
	});

	it('clears the remembered preference rather than storing a sentinel', async () => {
		localStorage.setItem('glyphstream:aspectRatio', '16:9');
		render(AspectRatioSelector, { props: { options: OPTIONS, value: null } });
		expect(trigger()).toHaveTextContent('16:9');

		const user = userEvent.setup();
		await user.click(trigger());
		await user.click(defaultRow());
		// Absent key IS the no-preference state, so there is nothing to store.
		expect(localStorage.getItem('glyphstream:aspectRatio')).toBeNull();
	});

	it('survives the selector being destroyed and recreated', async () => {
		// Default is remembered by the ABSENCE of the stored key, where every other
		// pick is remembered by its presence — so the remount reads nothing and has
		// to arrive at Default anyway. The composer destroys this selector on every
		// switch to a model without ratios, so the round trip is routine, not rare.
		const { rerender } = render(Harness, { props: { options: OPTIONS } });
		await pick('16:9');

		const user = userEvent.setup();
		await user.click(trigger());
		await user.click(defaultRow());
		expect(trigger()).toHaveTextContent('Default');

		await rerender({ options: OPTIONS, mounted: false });
		await rerender({ options: OPTIONS, mounted: true });
		expect(trigger()).toHaveTextContent('Default');
	});

	it('names the resolved shape when the selection agrees on one', async () => {
		render(AspectRatioSelector, {
			props: { options: OPTIONS, defaultValue: '9:16', value: null },
		});
		// The row lives in Popover.Content, which only mounts while open.
		await userEvent.setup().click(trigger());
		expect(defaultRow()).toHaveTextContent("The model's own — 9:16");
	});

	it('says "each model\'s own" when they disagree or none is advertised', async () => {
		// The composers pass no defaultValue when the selected models' defaults
		// differ — naming one of them would be arbitrary and wrong for the others.
		render(AspectRatioSelector, { props: { options: OPTIONS, value: null } });
		await userEvent.setup().click(trigger());
		expect(defaultRow()).toHaveTextContent("Each model's own");
	});
});
