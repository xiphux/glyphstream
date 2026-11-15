/**
 * Validate a request-body `disabledFeatures` payload (per-conversation
 * feature opt-out, see FEATURE_CATEGORIES in #lib/types/api).
 *
 * Accepts unknown / null / undefined → `[]` (no opt-outs); an array of
 * known categories → that array, with duplicates removed. Throws
 * `FeatureCategoryValidationError` for anything else (non-array,
 * non-string or empty entries, unknown category keys). Route handlers
 * convert the throw to a 400 — unknown keys are surfaced loudly rather
 * than silently dropped so client typos don't quietly become "feature on."
 *
 * "Known" means registered in the live feature catalog, with one
 * exception: any `mcp:<id>` passes even when that server isn't currently
 * registered. A config.toml edit that temporarily removes an MCP server
 * must not make every stored list mentioning it unsaveable; runtime tool
 * filtering treats an absent category as a no-op.
 *
 * This is for client input only. Stored lists (a preset's materialized
 * defaults, a scheduled task's saved toggles) are not re-validated when the
 * server itself copies them into a new conversation — so removing a
 * built-in category must also strip it from stored rows, or clients
 * echoing a stored list back would start to 400.
 */

import { error } from '@sveltejs/kit';
import { getRegisteredCategoryIds } from '#lib/server/feature-catalog.js';
import { isFeatureCategoryString } from '#lib/types/api.js';
import type { FeatureCategory } from '#lib/types/api.js';

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
	if (out.length === 0) return out;
	const known = getRegisteredCategoryIds();
	for (const entry of out) {
		if (!known.has(entry) && !entry.startsWith('mcp:')) {
			throw new FeatureCategoryValidationError(`Unknown feature category "${entry}"`);
		}
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
		if (e instanceof FeatureCategoryValidationError) error(400, e.message);
		throw e;
	}
}
