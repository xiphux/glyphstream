/**
 * Picking up a ratio the user wrote into the prompt itself — "create a 9:16
 * poster of…" — and, more importantly, LOSING to them when they disagree.
 *
 * Detection is the fourth thing competing to set this control, after the
 * remembered preference, the one-shot gallery seed, and an explicit pick. The
 * precedence between them is the whole risk of the feature: rank it too high and
 * the dropdown becomes unoverridable, because every keystroke re-asserts it.
 * That is what most of this file is about.
 *
 * The debounce means nothing here is synchronous — every assertion has to be
 * awaited past the timer, hence fake timers throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import Harness from './_helpers/AspectRatioSeedHarness.svelte';
import type { AspectRatioOption } from '$lib/types/api';

const OPTIONS: AspectRatioOption[] = [
	{ value: '1:1', label: 'Square' },
	{ value: '4:3', label: 'Standard' },
	{ value: '9:16', label: 'Portrait Widescreen' },
	{ value: '16:9', label: 'Widescreen' },
];

const trigger = () => screen.getByRole('button', { name: /^Aspect ratio/ });

/**
 * Advance past the detection debounce and let Svelte flush.
 *
 * `vi.advanceTimersByTime` fires the timer synchronously but the state write it
 * performs settles in a microtask, so the await is load-bearing.
 */
async function settle() {
	vi.advanceTimersByTime(400);
	await Promise.resolve();
	await Promise.resolve();
}

/** userEvent drives its own clock; it has to be told about the fake one. */
function user() {
	return userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });
}

async function pickFromMenu(value: string) {
	const u = user();
	await u.click(trigger());
	await u.click(screen.getByRole('button', { name: new RegExp(`^${value}`) }));
}

describe('AspectRatioSelector — a ratio named in the prompt', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('selects a ratio the prompt names', async () => {
		render(Harness, { props: { options: OPTIONS, promptText: 'create a 9:16 poster' } });
		await settle();
		expect(trigger()).toHaveTextContent('9:16');
	});

	it('detects immediately when it mounts onto text that is already there', async () => {
		// A restored draft, or the remount after a model switch. The debounce governs
		// TYPING — waiting it out here would only show the user a shape their prompt
		// contradicts, and it would also open a window in which no detection stands,
		// which is the signal the dismissal release reads.
		render(Harness, { props: { options: OPTIONS, promptText: 'create a 9:16 poster' } });
		expect(trigger()).toHaveTextContent('9:16');
	});

	it('says so on the trigger, so an unrequested change is explained', async () => {
		render(Harness, { props: { options: OPTIONS, promptText: 'a 16:9 still' } });
		await settle();
		expect(screen.getByRole('button', { name: /found in your prompt/i })).toBeInTheDocument();
	});

	it('claims nothing when the prompt names no offered ratio', async () => {
		render(Harness, { props: { options: OPTIONS, promptText: 'a clock showing 3:45' } });
		await settle();
		expect(trigger()).toHaveTextContent('Default');
		expect(screen.queryByRole('button', { name: /found in your prompt/i })).toBeNull();
	});

	it('outranks the remembered preference — it is about THIS image', async () => {
		localStorage.setItem('glyphstream:aspectRatio', '1:1');
		render(Harness, { props: { options: OPTIONS, promptText: 'make it 16:9' } });
		await settle();
		expect(trigger()).toHaveTextContent('16:9');
	});

	it('loses to the one-shot seed, which is the more specific intent', async () => {
		// Regenerating a particular image reproduces ITS framing; the prompt text
		// being re-run is the same prose that produced it.
		render(Harness, {
			props: { options: OPTIONS, initialSeed: '1:1', promptText: 'a 16:9 still' },
		});
		await settle();
		expect(trigger()).toHaveTextContent('1:1');
		expect(screen.queryByRole('button', { name: /found in your prompt/i })).toBeNull();
	});

	it('does not re-assert itself over an explicit pick', async () => {
		// The failure this guards against is the bad one: a detection that outranks
		// the user makes the control unusable, because it comes back on every
		// keystroke and there is no way to say no.
		const { rerender } = render(Harness, {
			props: { options: OPTIONS, promptText: 'a 16:9 still' },
		});
		await settle();
		expect(trigger()).toHaveTextContent('16:9');

		await pickFromMenu('1:1');
		expect(trigger()).toHaveTextContent('1:1');

		// Keep typing, same ratio still sitting in the text.
		await rerender({ options: OPTIONS, promptText: 'a 16:9 still, dramatic lighting' });
		await settle();
		expect(trigger()).toHaveTextContent('1:1');
	});

	it('survives being overridden by Default specifically', async () => {
		// Default is null, so a dismissal recorded as "truthy value present" would
		// read this as no override at all and snap back.
		const { rerender } = render(Harness, {
			props: { options: OPTIONS, promptText: 'a 16:9 still' },
		});
		await settle();
		const u = user();
		await u.click(trigger());
		await u.click(screen.getByRole('button', { name: /^Default/ }));
		expect(trigger()).toHaveTextContent('Default');

		await rerender({ options: OPTIONS, promptText: 'a 16:9 still and more' });
		await settle();
		expect(trigger()).toHaveTextContent('Default');
	});

	it('speaks up again when the prompt names a DIFFERENT ratio', async () => {
		// The reason the override is remembered by value rather than as a flag: the
		// user editing 16:9 → 9:16 in their text is a new request, not the old one.
		const { rerender } = render(Harness, {
			props: { options: OPTIONS, promptText: 'a 16:9 still' },
		});
		await settle();
		await pickFromMenu('1:1');
		expect(trigger()).toHaveTextContent('1:1');

		await rerender({ options: OPTIONS, promptText: 'a 9:16 still' });
		await settle();
		expect(trigger()).toHaveTextContent('9:16');
	});

	it('steps aside when the named ratio is deleted from the prompt', async () => {
		// Falls back down the chain rather than stranding the value it set.
		localStorage.setItem('glyphstream:aspectRatio', '1:1');
		const { rerender } = render(Harness, {
			props: { options: OPTIONS, promptText: 'a 16:9 still' },
		});
		await settle();
		expect(trigger()).toHaveTextContent('16:9');

		await rerender({ options: OPTIONS, promptText: 'a still' });
		await settle();
		expect(trigger()).toHaveTextContent('1:1');
	});

	it('does not revert an explicit pick when the selector is destroyed and recreated', async () => {
		// The regression that matters. The composer tears this control down whenever
		// the selection stops offering ratios — and the chat page tears the whole
		// composer down for the duration of an inline edit — while the prompt that
		// produced the detection lives in the page and survives untouched. A
		// dismissal held inside the component resets on the remount, the unchanged
		// prompt is re-detected, and the shape the user overrode comes back.
		const { rerender } = render(Harness, {
			props: { options: OPTIONS, promptText: 'a 16:9 still' },
		});
		await settle();
		await pickFromMenu('1:1');
		expect(trigger()).toHaveTextContent('1:1');

		await rerender({ options: OPTIONS, promptText: 'a 16:9 still', mounted: false });
		expect(screen.queryByRole('button', { name: /^Aspect ratio/ })).toBeNull();
		await rerender({ options: OPTIONS, promptText: 'a 16:9 still', mounted: true });
		await settle();

		expect(trigger()).toHaveTextContent('1:1');
	});

	it('lets the same ratio speak again in a LATER prompt', async () => {
		// An override answers the detection standing at that moment, not that ratio
		// forever. On the chat page the composer survives a send, so without a
		// release the user could override 16:9 once and have every later prompt
		// naming 16:9 silently ignored for the rest of the conversation.
		const { rerender } = render(Harness, {
			props: { options: OPTIONS, promptText: 'a 16:9 still' },
		});
		await settle();
		await pickFromMenu('1:1');
		expect(trigger()).toHaveTextContent('1:1');

		// The send clears the box; the component instance is untouched.
		await rerender({ options: OPTIONS, promptText: '' });
		await settle();
		await rerender({ options: OPTIONS, promptText: 'a 16:9 landscape at dusk' });
		await settle();

		expect(trigger()).toHaveTextContent('16:9');
	});

	it('keeps the dismissal when the MENU changes but the prose does not', async () => {
		// A dismissal answers what the prompt says, so only the prompt can retract
		// it. Releasing on "nothing is detected" would also release when the
		// selection merely stopped OFFERING that shape — so a mid-compose hop
		// between two ratio-offering models would drop the override and let the
		// unchanged text overrule the pick on the way back.
		const WITH_16_9 = [{ value: '1:1' }, { value: '16:9' }];
		const WITHOUT_16_9 = [{ value: '1:1' }, { value: '9:16' }];
		const { rerender } = render(Harness, {
			props: { options: WITH_16_9, promptText: 'a 16:9 still' },
		});
		await settle();
		await pickFromMenu('1:1');
		expect(trigger()).toHaveTextContent('1:1');

		// Switch to a model that does not offer 16:9, then back. The text never moved.
		await rerender({ options: WITHOUT_16_9, promptText: 'a 16:9 still' });
		await settle();
		await rerender({ options: WITH_16_9, promptText: 'a 16:9 still' });
		await settle();

		expect(trigger()).toHaveTextContent('1:1');
	});

	it('marks no menu row when a seed outranks the detection', async () => {
		// All three affordances key off `fromPrompt`, so they agree. The row marker
		// keyed to the detection alone would sparkle a row the prompt named but the
		// seed overruled — unselected, and with no line above to explain it, since
		// that line is gated.
		render(Harness, {
			props: { options: OPTIONS, initialSeed: '1:1', promptText: 'a 16:9 still' },
		});
		await settle();
		await user().click(trigger());

		expect(screen.queryByText(/Found .* in your prompt/i)).toBeNull();
		// One svg is the row's own shape glyph; a second would be the marker.
		const row = screen.getByRole('button', { name: /^16:9/ });
		expect(row.querySelectorAll('svg')).toHaveLength(1);
	});

	it('does not flicker through a ratio that is a prefix of the one being typed', async () => {
		// The debounce earns its keep only when the advertised list contains a ratio
		// that is a TEXT PREFIX of another, because exact matching already ignores
		// every partial that nobody offers. Here "9:1" is offered and is what "9:16"
		// is typed through, so an unthrottled picker would show 9:1 on the way past.
		// Whether that pair is advertised is a property of someone's workflow, not
		// of this code, which is the argument for throttling rather than auditing
		// the list.
		const COLLIDING = [...OPTIONS, { value: '9:1', label: 'Slim Panorama' }];
		// Each keystroke has to advance the clock by LESS than the debounce, or the
		// timer never fires and the test would pass at any debounce length.
		const type = async (promptText: string) => {
			await rerender({ options: COLLIDING, promptText });
			vi.advanceTimersByTime(100);
			await Promise.resolve();
		};
		const { rerender } = render(Harness, { props: { options: COLLIDING, promptText: 'a 9' } });
		await type('a 9:');
		await type('a 9:1');
		await type('a 9:16');
		expect(trigger()).toHaveTextContent('Default');

		await settle();
		expect(trigger()).toHaveTextContent('9:16');
	});
});
