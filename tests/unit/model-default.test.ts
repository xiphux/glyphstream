/**
 * The composer's starting model, and the catalogue slice needed to render it.
 *
 * Worth pinning precisely because this rule now has two callers — the server
 * decides the selection and trims the payload with it, the page renders what it
 * decided — and a divergence between them is silent: the picker would simply
 * show a model the user never chose, with nothing failing.
 */
import { describe, expect, it } from 'vitest';
import { firstPaintModelIds, pickDefaultModelId } from '../../src/lib/model-default';

const models = [
	{ id: 'ep::img', kind: 'image' },
	{ id: 'ep::chat', kind: 'chat' },
	{ id: 'ep::vid', kind: 'video' },
	{ id: 'ep::weird', kind: 'embedding' },
];
const presets = [
	{ id: 'p1', baseEndpointId: 'ep', baseModelId: 'chat' },
	{ id: 'p-embed', baseEndpointId: 'ep', baseModelId: 'weird' },
];

describe('pickDefaultModelId', () => {
	it('takes the first composable favourite, in the userderived order', () => {
		expect(pickDefaultModelId({ favorites: ['ep::vid', 'ep::chat'], presets, models })).toBe(
			'ep::vid',
		);
	});

	it('returns the PRESET id, not its base, when a preset wins', () => {
		// The preset is what the user favourited; resolving to its base would
		// silently drop the system prompt and params it carries.
		expect(pickDefaultModelId({ favorites: ['custom::p1'], presets, models })).toBe('custom::p1');
	});

	it('skips a favourite whose kind cannot drive the composer', () => {
		expect(pickDefaultModelId({ favorites: ['ep::weird', 'ep::chat'], presets, models })).toBe(
			'ep::chat',
		);
		expect(pickDefaultModelId({ favorites: ['custom::p-embed', 'ep::img'], presets, models })).toBe(
			'ep::img',
		);
	});

	it('skips a favourite pointing at something that no longer exists', () => {
		// Favourites outlive both presets and an endpoint's advertised list, so
		// a dangling one must fall through rather than select nothing.
		expect(pickDefaultModelId({ favorites: ['custom::gone', 'ep::chat'], presets, models })).toBe(
			'ep::chat',
		);
		expect(pickDefaultModelId({ favorites: ['ep::retired', 'ep::chat'], presets, models })).toBe(
			'ep::chat',
		);
	});

	it('falls back chat, then image, then video — in that order, not list order', () => {
		// `models` above deliberately lists image FIRST, so a naive "first
		// composable entry" would answer ep::img.
		expect(pickDefaultModelId({ favorites: [], presets, models })).toBe('ep::chat');
		expect(pickDefaultModelId({ favorites: [], presets, models: [models[0], models[2]] })).toBe(
			'ep::img',
		);
		expect(pickDefaultModelId({ favorites: [], presets, models: [models[2]] })).toBe('ep::vid');
	});

	it('returns empty string when nothing is composable', () => {
		expect(pickDefaultModelId({ favorites: [], presets, models: [models[3]] })).toBe('');
		expect(pickDefaultModelId({ favorites: [], presets, models: [] })).toBe('');
	});
});

describe('firstPaintModelIds', () => {
	it('collects the selection, every favourite, and a URL target', () => {
		const ids = firstPaintModelIds({
			favorites: ['ep::img', 'custom::p1'],
			presets,
			defaultModelId: 'ep::img',
			urlModelId: 'ep::vid',
		});
		// custom::p1 resolves to its BASE — that entry is what renders the label.
		expect([...ids].sort()).toEqual(['ep::chat', 'ep::img', 'ep::vid']);
	});

	it('drops a favourite whose preset is gone rather than inventing an id', () => {
		const ids = firstPaintModelIds({
			favorites: ['custom::gone'],
			presets,
			defaultModelId: 'ep::chat',
		});
		expect([...ids]).toEqual(['ep::chat']);
	});

	it('ignores empty ids so a blank selection adds nothing', () => {
		expect([...firstPaintModelIds({ favorites: [], presets, defaultModelId: '' })]).toEqual([]);
	});

	it('always contains what pickDefaultModelId chose', () => {
		// The invariant that keeps the trim honest: whatever the server selects
		// must be renderable from what the server ships.
		const favorites = ['custom::p1', 'ep::weird'];
		const chosen = pickDefaultModelId({ favorites, presets, models });
		const ids = firstPaintModelIds({ favorites, presets, defaultModelId: chosen });
		const chosenBase = chosen.startsWith('custom::') ? 'ep::chat' : chosen;
		expect(ids.has(chosenBase)).toBe(true);
	});
});
