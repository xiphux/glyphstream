/**
 * Where a NEW conversation's feature opt-outs start.
 *
 * Three sources want a say, and the order between them is the whole content of
 * this module — it's a precedence rule, not a merge, and it's exactly the kind
 * of thing that regresses silently inside a `$effect` in the new-chat page.
 *
 *   1. A REUSED PROMPT's carried-over toggles win outright. Those aren't a
 *      default at all: they're what the user settled on in a real conversation,
 *      and re-applying a default over them would undo a deliberate choice.
 *   2. Otherwise the user's standing `defaultDisabledFeatures` UNIONS with the
 *      selected preset's own. Both are defaults, and a preset must not quietly
 *      re-enable something the user switched off globally — "I never want emoji
 *      reactions" shouldn't stop being true because they picked a roleplay
 *      preset that doesn't mention reactions.
 *
 * Union in that direction only: neither source can turn something back ON that
 * the other turned off. Turning one back on is a per-conversation act, done at
 * the composer's toggle menu, where it stays.
 */

import type { FeatureCategory } from './types/api';

export interface SeedDisabledFeaturesInput {
	/** The user's standing defaults (`prefs.defaultDisabledFeatures`). */
	userDefaults: readonly FeatureCategory[];
	/** The selected custom-model preset's `defaultDisabledFeatures`, or null when
	 *  a base model is picked (a base model contributes nothing of its own). */
	presetDefaults?: readonly FeatureCategory[] | null;
	/** Toggles carried in from a reused prompt. When present, these are used
	 *  verbatim and both default sources are ignored. */
	reusedFrom?: readonly FeatureCategory[] | null;
}

export function seedDisabledFeatures(input: SeedDisabledFeaturesInput): FeatureCategory[] {
	if (input.reusedFrom) return [...input.reusedFrom];
	return [...new Set([...input.userDefaults, ...(input.presetDefaults ?? [])])];
}
