/**
 * CanvasController.sync — merging a same-conversation reload's seed.
 *
 * The regression: the pane was only ever updated by the live `canvas_version`
 * stream event, and a same-conversation reload deliberately skipped re-seeding.
 * A turn whose event this tab never received (finished by the recovery poll,
 * run while the stream was detached) left the pane on the pre-turn version —
 * and the inline card reopened that stale version — until a full page reload.
 */
import { describe, it, expect } from 'vitest';
import { CanvasController, type CanvasSeed } from '#lib/canvas-controller.svelte.js';

function seed(id: string, versionNumber: number, updatedAt = versionNumber): CanvasSeed {
	return {
		id,
		title: `Doc ${id}`,
		content: `${id} v${versionNumber}`,
		contentHtml: `<p>${id} v${versionNumber}</p>`,
		currentVersionId: `${id}-v${versionNumber}`,
		versionNumber,
		updatedAt,
	};
}

describe('CanvasController.sync', () => {
	it('takes a newer version the live event never delivered', () => {
		const c = new CanvasController();
		c.hydrate([seed('a', 1)]);
		c.sync([seed('a', 2)]);
		expect(c.current?.versionNumber).toBe(2);
		expect(c.current?.content).toBe('a v2');
	});

	it('leaves a closed pane closed and keeps focus', () => {
		const c = new CanvasController();
		c.hydrate([seed('a', 1, 1), seed('b', 1, 2)]);
		c.focus('a');
		c.sync([seed('a', 1), seed('b', 2)]);
		expect(c.open).toBe(false);
		expect(c.focusedId).toBe('a');
		expect(c.docs.find((d) => d.artifactId === 'b')?.versionNumber).toBe(2);
	});

	it('never rolls a live-applied version back to an older seed', () => {
		const c = new CanvasController();
		c.hydrate([seed('a', 1)]);
		c.apply({
			artifactId: 'a',
			versionId: 'a-v3',
			title: 'Doc a',
			content: 'a v3',
			contentHtml: null,
			versionNumber: 3,
			editSource: 'agent',
		});
		c.sync([seed('a', 2)]);
		expect(c.current?.versionNumber).toBe(3);
	});

	it('appends a canvas created in a turn it never heard about', () => {
		const c = new CanvasController();
		c.hydrate([]);
		c.sync([seed('a', 1)]);
		expect(c.docs).toHaveLength(1);
		expect(c.focusedId).toBe('a');
		c.show('a');
		expect(c.current?.content).toBe('a v1');
	});
});
