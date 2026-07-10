/**
 * Parsers for the JSON-encoded text columns in the schema. Every DB text
 * column that stores JSON is read through one of these, so the
 * "defensively parse, fall back on garbage" idiom — and the exact
 * fallback for each column type — lives in one place rather than being
 * re-inlined at each row-mapping site.
 */

import { isFeatureCategoryString } from '$lib/types/api';
import type { CompareSelection } from '$lib/fanout';
import type { CustomModelParameters, FeatureCategory, MessagePart } from '$lib/types/api';

/**
 * Parse a message row's `content_json` column into MessagePart[]. Falls
 * back to an empty array on invalid JSON *or* a non-array payload — a
 * malformed message renders empty rather than crashing the branch walk.
 */
export function parseMessageParts(raw: string): MessagePart[] {
	try {
		const parsed = JSON.parse(raw) as MessagePart[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Parse a `parameters_json` column into CustomModelParameters. Returns
 * null for an absent/empty column or invalid JSON.
 */
export function parseModelParameters(raw: string | null): CustomModelParameters | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as CustomModelParameters;
	} catch {
		return null;
	}
}

/**
 * Parse a `disabled_features` column into FeatureCategory[]. Always
 * returns an array (never null) so callers don't have to branch — null
 * column / invalid JSON / non-array payload / non-string entries all
 * normalize to an empty list (i.e. "all features on"). Both built-in
 * categories AND opaque MCP categories (`mcp:<server-id>`) pass through
 * unchanged: a category whose backing MCP server isn't currently
 * registered survives a round-trip so the user's preference isn't lost
 * across a transient config edit.
 */
export function parseDisabledFeatures(raw: string | null): FeatureCategory[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isFeatureCategoryString);
}

/**
 * Parse a `dispatched_models` column into CompareSelection[]. Returns null
 * for an absent column, invalid JSON, or a payload that isn't a non-empty
 * array of well-formed entries — the callers treat null as "no record" and
 * fall back to the reply's `model_used`, so a garbage row degrades to the
 * legacy path rather than seeding a bogus compare cart. Model ids are NOT
 * validated against the current config here: an id that no longer resolves
 * is dropped at read time by the consumer (same contract as saved model
 * sets), so a transient config edit doesn't garden the stored record.
 */
export function parseDispatchedModels(raw: string | null): CompareSelection[] | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const out: CompareSelection[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') return null;
		const { modelId, count } = entry as Partial<CompareSelection>;
		if (typeof modelId !== 'string' || !modelId) return null;
		if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
		out.push({ modelId, count });
	}
	return out;
}
