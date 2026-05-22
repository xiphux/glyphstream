/** Tests for the composer drag/paste helpers. */

import { describe, expect, it } from 'vitest';
import { dragHasFiles, extractImageFiles } from '$lib/composer';

function img(name: string): File {
	return new File(['x'], name, { type: 'image/png' });
}
function txt(name: string): File {
	return new File(['x'], name, { type: 'text/plain' });
}

describe('dragHasFiles', () => {
	it('is true when the drag carries files', () => {
		expect(dragHasFiles({ dataTransfer: { types: ['Files'] } } as unknown as DragEvent)).toBe(true);
	});

	it('is false for a text-only or empty drag', () => {
		expect(
			dragHasFiles({ dataTransfer: { types: ['text/plain'] } } as unknown as DragEvent)
		).toBe(false);
		expect(dragHasFiles({ dataTransfer: null } as unknown as DragEvent)).toBe(false);
	});
});

describe('extractImageFiles', () => {
	it('returns image files from .files, dropping non-images', () => {
		const dt = { files: [img('a.png'), txt('b.txt')], items: [] } as unknown as DataTransfer;
		expect(extractImageFiles(dt).map((f) => f.name)).toEqual(['a.png']);
	});

	it('falls back to .items when .files is empty', () => {
		const items = [
			{ kind: 'file', type: 'image/png', getAsFile: () => img('c.png') },
			{ kind: 'string', type: 'text/plain', getAsFile: () => null }
		];
		const dt = { files: [], items } as unknown as DataTransfer;
		expect(extractImageFiles(dt).map((f) => f.name)).toEqual(['c.png']);
	});

	it('returns [] for a null source', () => {
		expect(extractImageFiles(null)).toEqual([]);
	});
});
