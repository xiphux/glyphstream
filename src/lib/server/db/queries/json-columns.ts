/**
 * Parsers for the JSON-encoded text columns in the schema. Every DB text
 * column that stores JSON is read through one of these, so the
 * "defensively parse, fall back on garbage" idiom — and the exact
 * fallback for each column type — lives in one place rather than being
 * re-inlined at each row-mapping site.
 */

import type { CustomModelParameters, MessagePart } from '$lib/types/api';

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
