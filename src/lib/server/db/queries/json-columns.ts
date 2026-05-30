/**
 * Parsers for the JSON-encoded text columns in the schema. Every DB text
 * column that stores JSON is read through one of these, so the
 * "defensively parse, fall back on garbage" idiom — and the exact
 * fallback for each column type — lives in one place rather than being
 * re-inlined at each row-mapping site.
 */

import { isFeatureCategoryString } from '$lib/types/api';
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
