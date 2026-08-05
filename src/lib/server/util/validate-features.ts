/**
 * Validate a request-body `disabledFeatures` payload (per-conversation
 * feature opt-out, see FEATURE_CATEGORIES in $lib/types/api).
 *
 * Accepts unknown / null / undefined → `[]` (no opt-outs); an array of
 * known FeatureCategory strings → that array, with duplicates removed.
 * Throws `FeatureCategoryValidationError` for anything else (non-array,
 * non-string entries, unknown category keys). Route handlers convert
 * the throw to a 400 — unknown keys are surfaced loudly rather than
 * silently dropped so client typos don't quietly become "feature on."
 */

import { error } from '@sveltejs/kit';
import { isFeatureCategoryString } from '$lib/types/api';
import type { FeatureCategory } from '$lib/types/api';

export class FeatureCategoryValidationError extends Error {}

export function validateDisabledFeatures(raw: unknown): FeatureCategory[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new FeatureCategoryValidationError(
			'disabledFeatures must be an array of category strings',
		);
	}
	const out: FeatureCategory[] = [];
	for (const entry of raw) {
		if (!isFeatureCategoryString(entry)) {
			throw new FeatureCategoryValidationError(
				`Invalid feature category entry: ${JSON.stringify(entry)}`,
			);
		}
		if (!out.includes(entry)) out.push(entry);
	}
	return out;
}

/**
 * Route-handler convenience: validate, and convert a
 * FeatureCategoryValidationError into a SvelteKit 400 in one step.
 */
export function validateDisabledFeaturesOrThrow400(raw: unknown): FeatureCategory[] {
	try {
		return validateDisabledFeatures(raw);
	} catch (e) {
		if (e instanceof FeatureCategoryValidationError) throw error(400, e.message);
		throw e;
	}
}
