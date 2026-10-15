/**
 * The selection-derived state both composers share (composer-selection.ts).
 */
import { describe, expect, it } from 'vitest';
import type { ModelEntry } from '#lib/types/api.js';
import {
	canSplitAttachments,
	composerPlaceholder,
	resolveModels,
	selectedModelIds,
	selectionNeedsImage,
	skillCommandsFor,
} from '#lib/composer-selection.js';

const model = (id: string, imageInput?: 'required' | 'optional'): ModelEntry =>
	({
		id,
		displayName: id,
		kind: 'image',
		capabilities:
			imageInput === 'required'
				? ['image-to-image']
				: imageInput === 'optional'
					? ['text-to-image', 'image-to-image']
					: ['text-to-image'],
	}) as unknown as ModelEntry;

describe('selectedModelIds', () => {
	it('is the cart, each once, in compare mode', () => {
		expect(selectedModelIds(true, ['a', 'b', 'a'], 'x')).toEqual(['a', 'b']);
	});
	it('falls back to the picked model outside compare mode or with an empty cart', () => {
		expect(selectedModelIds(false, ['a'], 'x')).toEqual(['x']);
		expect(selectedModelIds(true, [], 'x')).toEqual(['x']);
	});
});

describe('resolveModels', () => {
	it('drops ids the catalogue cannot resolve', () => {
		const a = model('a');
		expect(resolveModels(['a', 'gone'], (id) => (id === 'a' ? a : undefined))).toEqual([a]);
	});
});

describe('selectionNeedsImage', () => {
	it('blocks only when a selected model requires an image and none is attached', () => {
		const req = model('upscaler', 'required');
		expect(selectionNeedsImage([model('t2i'), req], 0)).toBe(true);
		expect(selectionNeedsImage([model('t2i')], 0)).toBe(false);
		expect(selectionNeedsImage([req], 1)).toBe(false);
	});
});

describe('composerPlaceholder', () => {
	it('invites what the active kind can act on', () => {
		expect(composerPlaceholder('chat', 'unknown', false, 'Ask anything')).toBe('Ask anything');
		expect(composerPlaceholder('image', 'unknown', false, '')).toBe(
			'Describe an image to generate…',
		);
		expect(composerPlaceholder('image', 'required', false, '')).toBe('Attach an image to edit…');
		expect(composerPlaceholder('image', 'required', true, '')).toBe('Describe the edit…');
		expect(composerPlaceholder('video', 'required', false, '')).toBe('Attach an image to animate…');
		expect(composerPlaceholder('video', 'optional', false, '')).toBe(
			'Describe a video to generate…',
		);
	});
});

describe('canSplitAttachments / skillCommandsFor', () => {
	it('splits only media generations with two or more images', () => {
		expect(canSplitAttachments('image', 2)).toBe(true);
		expect(canSplitAttachments('video', 3)).toBe(true);
		expect(canSplitAttachments('image', 1)).toBe(false);
		expect(canSplitAttachments('chat', 5)).toBe(false);
	});
	it('offers the /skill menu only in a chat with skills on', () => {
		const skills = [{ name: 's' }];
		expect(skillCommandsFor('chat', [], skills)).toBe(skills);
		expect(skillCommandsFor('chat', ['skills'], skills)).toBeUndefined();
		expect(skillCommandsFor('image', [], skills)).toBeUndefined();
	});
});
