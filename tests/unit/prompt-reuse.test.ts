/**
 * Unit tests for the "New chat from this prompt" model derivation: rebuilding a
 * picker selection from the dispatch recorded on the user message, and putting
 * back the custom-model preset the conversation was created from.
 */

import { describe, expect, it } from 'vitest';
import {
	deriveReuseModels,
	resolveIntentSelection,
	upgradeToPresetModelId,
} from '$lib/prompt-reuse';
import type { CompareSelection } from '$lib/fanout';
import type { ModelKind } from '$lib/types/api';

const KINDS: Record<string, ModelKind> = {
	'bridge::a': 'chat',
	'bridge::b': 'chat',
	'bridge::sdxl': 'image',
};
const resolve = (id: string) => (KINDS[id] ? { kind: KINDS[id] } : undefined);

const sel = (modelId: string, count = 1): CompareSelection => ({ modelId, count });

describe('deriveReuseModels', () => {
	it('seeds a compare cart from a multi-model dispatch', () => {
		expect(deriveReuseModels([sel('bridge::a'), sel('bridge::b')], null, resolve)).toEqual({
			modelId: 'bridge::a',
			compareSelections: [sel('bridge::a'), sel('bridge::b')],
		});
	});

	// The case the whole `dispatched_models` column exists for: a same-model ×N
	// fan-out is a comparison, not a single send. Counting distinct models would
	// silently drop two of the three generations the user asked for.
	it('preserves counts for a same-model ×N fan-out', () => {
		expect(deriveReuseModels([sel('bridge::a', 3)], null, resolve)).toEqual({
			modelId: 'bridge::a',
			compareSelections: [sel('bridge::a', 3)],
		});
	});

	it('collapses a single-branch dispatch to a single model, no cart', () => {
		expect(deriveReuseModels([sel('bridge::a')], null, resolve)).toEqual({
			modelId: 'bridge::a',
			compareSelections: null,
		});
	});

	it('drops model ids that no longer resolve against config', () => {
		expect(deriveReuseModels([sel('bridge::gone'), sel('bridge::b')], null, resolve)).toEqual({
			modelId: 'bridge::b',
			compareSelections: null,
		});
	});

	// Compare carts are kind-homogeneous (ModelPicker locks the cart to its first
	// model's kind), so a dispatch that went mixed — only possible if config
	// changed a model's kind afterwards — must not seed an unacceptable cart.
	it('filters a mixed-kind dispatch down to the first survivor’s kind', () => {
		expect(deriveReuseModels([sel('bridge::a'), sel('bridge::sdxl')], null, resolve)).toEqual({
			modelId: 'bridge::a',
			compareSelections: null,
		});
	});

	describe('legacy rows with no recorded dispatch', () => {
		it('falls back to the supplied model id', () => {
			expect(deriveReuseModels(undefined, 'bridge::b', resolve)).toEqual({
				modelId: 'bridge::b',
				compareSelections: null,
			});
		});

		it('falls back again when every recorded id is unresolvable', () => {
			expect(deriveReuseModels([sel('bridge::gone')], 'bridge::a', resolve)).toEqual({
				modelId: 'bridge::a',
				compareSelections: null,
			});
		});

		// A bare upstream id (OWUI import) resolves to nothing — hand back null so
		// the new-chat page picks its own default rather than seeding a dead model.
		it('yields null when the fallback itself is unresolvable', () => {
			expect(deriveReuseModels(undefined, 'gpt-4o', resolve)).toEqual({
				modelId: null,
				compareSelections: null,
			});
		});

		it('yields null when there is no fallback at all', () => {
			expect(deriveReuseModels(undefined, null, resolve)).toEqual({
				modelId: null,
				compareSelections: null,
			});
		});
	});

	it('does not alias the stored selections into the returned cart', () => {
		const stored = [sel('bridge::a'), sel('bridge::b')];
		const { compareSelections } = deriveReuseModels(stored, null, resolve);
		compareSelections![0].count = 99;
		expect(stored[0].count).toBe(1);
	});
});

describe('resolveIntentSelection', () => {
	// `bridge::a` has been removed from config since the intent was built.
	const isKnown = (id: string) => id !== 'bridge::a';
	const intent = (modelId: string | null, compareSelections: CompareSelection[] | null = null) => ({
		modelId,
		compareSelections,
	});

	it('keeps a fully-resolvable cart', () => {
		expect(
			resolveIntentSelection(intent('bridge::b', [sel('bridge::b'), sel('bridge::sdxl')]), isKnown),
		).toEqual({
			modelId: 'bridge::b',
			compareSelections: [sel('bridge::b'), sel('bridge::sdxl')],
		});
	});

	// deriveReuseModels puts the cart's FIRST entry in `modelId`, so the intent's
	// model is exactly as mortal as any cart member. Dropping to the page's
	// default here would be worse than not filtering at all: the send would go to
	// a model the user never picked, instead of to the one that survived.
	it('adopts a survivor when the cart’s first entry is the one removed', () => {
		expect(
			resolveIntentSelection(intent('bridge::a', [sel('bridge::a'), sel('bridge::b')]), isKnown),
		).toEqual({ modelId: 'bridge::b', compareSelections: null });
	});

	it('keeps comparing when the removed entry still leaves two branches', () => {
		expect(
			resolveIntentSelection(
				intent('bridge::a', [sel('bridge::a'), sel('bridge::b'), sel('bridge::sdxl')]),
				isKnown,
			),
		).toEqual({
			modelId: 'bridge::b',
			compareSelections: [sel('bridge::b'), sel('bridge::sdxl')],
		});
	});

	it('collapses to the single model when a non-first entry is removed', () => {
		expect(
			resolveIntentSelection(intent('bridge::b', [sel('bridge::b'), sel('bridge::a')]), isKnown),
		).toEqual({ modelId: 'bridge::b', compareSelections: null });
	});

	// A ×N cart of one model is still a comparison; losing a *different* model
	// from it must not silently drop the extra branches.
	it('keeps a surviving ×N entry as a cart', () => {
		expect(
			resolveIntentSelection(intent('bridge::a', [sel('bridge::a'), sel('bridge::b', 2)]), isKnown),
		).toEqual({ modelId: 'bridge::b', compareSelections: [sel('bridge::b', 2)] });
	});

	it('passes a preset through untouched', () => {
		expect(resolveIntentSelection(intent('custom::cm-1'), isKnown)).toEqual({
			modelId: 'custom::cm-1',
			compareSelections: null,
		});
	});

	it('yields null when nothing survives, leaving the default-model effect to pick', () => {
		expect(resolveIntentSelection(intent('bridge::a', [sel('bridge::a')]), isKnown)).toEqual({
			modelId: null,
			compareSelections: null,
		});
		expect(resolveIntentSelection(intent(null), isKnown)).toEqual({
			modelId: null,
			compareSelections: null,
		});
	});

	it('does not alias the intent’s cart into the applied selection', () => {
		const carried = [sel('bridge::b'), sel('bridge::sdxl')];
		const out = resolveIntentSelection(intent('bridge::b', carried), isKnown);
		out.compareSelections![0].count = 99;
		expect(carried[0].count).toBe(1);
	});
});

describe('upgradeToPresetModelId', () => {
	const presets = [{ id: 'cm-1', baseEndpointId: 'bridge', baseModelId: 'a' }];

	it('restores the preset when the model is its base model', () => {
		expect(upgradeToPresetModelId('bridge::a', 'cm-1', presets)).toBe('custom::cm-1');
	});

	// A conversation started from a preset but switched to another model must not
	// have the preset's system prompt silently re-applied on reuse.
	it('leaves a model that is not the preset’s base alone', () => {
		expect(upgradeToPresetModelId('bridge::b', 'cm-1', presets)).toBe('bridge::b');
	});

	it('passes through when the conversation has no preset', () => {
		expect(upgradeToPresetModelId('bridge::a', null, presets)).toBe('bridge::a');
	});

	// customModelId is a `set null`-on-delete FK, but a stale id can still arrive
	// from a page whose data loaded before the preset was deleted.
	it('passes through when the preset no longer exists', () => {
		expect(upgradeToPresetModelId('bridge::a', 'cm-gone', presets)).toBe('bridge::a');
	});

	it('passes through a null model id', () => {
		expect(upgradeToPresetModelId(null, 'cm-1', presets)).toBeNull();
	});
});
