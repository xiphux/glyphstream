/**
 * The avatar hides itself when its image fails, rather than showing a broken
 * image beside the label — from an error event, or from an image that had
 * already failed before the handler was attached (before hydration).
 *
 * happy-dom loads no images, so the image's state is set by hand (the shared
 * setup reports every image as still loading).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import AssistantAvatar from '#lib/components/chat/AssistantAvatar.svelte';

const KEYS = ['complete', 'naturalWidth'] as const;
const original = new Map(
	KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, k)]),
);

function imageState(state: { complete: boolean; naturalWidth: number }) {
	for (const key of KEYS) {
		Object.defineProperty(HTMLImageElement.prototype, key, {
			configurable: true,
			get: () => state[key],
		});
	}
}

afterEach(() => {
	for (const [key, descriptor] of original) {
		if (descriptor) Object.defineProperty(HTMLImageElement.prototype, key, descriptor);
		else delete (HTMLImageElement.prototype as unknown as Record<string, unknown>)[key];
	}
});

describe('AssistantAvatar', () => {
	it('hides itself when its image fails to load', async () => {
		const { container } = render(AssistantAvatar, { props: { mediaId: 'm1', label: 'Fox' } });
		const img = container.querySelector('img')!;
		expect(img).not.toBeNull();
		await fireEvent.error(img);
		expect(container.querySelector('img')).toBeNull();
	});

	it('hides itself for an image that broke before it was attached', () => {
		imageState({ complete: true, naturalWidth: 0 });
		const { container } = render(AssistantAvatar, { props: { mediaId: 'm1', label: 'Fox' } });
		expect(container.querySelector('img')).toBeNull();
	});

	it('stays for an image that loaded', () => {
		imageState({ complete: true, naturalWidth: 32 });
		const { container } = render(AssistantAvatar, { props: { mediaId: 'm1', label: 'Fox' } });
		expect(container.querySelector('img')).not.toBeNull();
	});
});
