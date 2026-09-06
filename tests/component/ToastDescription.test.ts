/* @vitest-environment happy-dom */

/**
 * Holds the line on the toast's secondary line actually reaching the DOM.
 *
 * `ShowOptions` did not declare `description` for a long time, and two callers
 * passed one anyway — spread in, as `...(x ? { description: x } : {})`. That
 * spelling type-checks against an option that does not exist, because
 * TypeScript's excess-property check only applies to properties written
 * literally in an object literal and a spread's properties are not fresh. So
 * `pnpm check` and `pnpm lint` were both blind, `show()` never read the field,
 * and every description was silently dropped — including a completion's body
 * line, which is everything the toast has to say about a finished turn beyond
 * naming its thread.
 *
 * A type alone can't hold this: the option can be declared and still never
 * rendered. So assert on the rendered text.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import Toaster from '$lib/components/Toaster.svelte';
import { toast } from '$lib/toast.svelte';

afterEach(() => {
	toast.dismiss();
});

describe('Toaster description', () => {
	it('renders the description under the message', () => {
		render(Toaster);
		toast.info('GlyphStream', { description: 'Video ready', duration: 0 });
		flushSync();
		expect(screen.getByText('GlyphStream')).toBeTruthy();
		expect(screen.getByText('Video ready')).toBeTruthy();
	});

	it('renders no description element when none is given', () => {
		const { container } = render(Toaster);
		toast.info('Just the message', { duration: 0 });
		flushSync();
		expect(screen.getByText('Just the message')).toBeTruthy();
		expect(container.textContent).not.toContain('undefined');
	});

	it('carries the description alongside an action button', () => {
		render(Toaster);
		toast.info('GlyphStream', {
			description: '3 images ready',
			action: { label: 'Open', handler: () => {} },
			duration: 0,
		});
		flushSync();
		expect(screen.getByText('3 images ready')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
	});
});
