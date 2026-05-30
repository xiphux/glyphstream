import { error } from '@sveltejs/kit';
import { getEndpoint } from '$lib/server/endpoints/registry';
import { getRegisteredCategoryIds } from '$lib/server/feature-categories';
import {
	FeatureCategoryValidationError,
	validateDisabledFeatures
} from '$lib/server/util/feature-categories';
import type {
	CreateCustomModelRequest,
	CustomModelParameters,
	FeatureCategory
} from '$lib/types/api';

export interface ValidatedCreate {
	name: string;
	description: string | null;
	baseEndpointId: string;
	baseModelId: string;
	systemPrompt: string | null;
	parameters: CustomModelParameters | null;
	defaultDisabledFeatures: FeatureCategory[];
}

export function validateCreateInput(body: CreateCustomModelRequest): ValidatedCreate {
	const name = body.name?.trim();
	if (!name) throw error(400, "'name' is required");
	if (name.length > 200) throw error(400, "'name' must be 200 characters or fewer");

	const baseEndpointId = body.baseEndpointId?.trim();
	if (!baseEndpointId) throw error(400, "'baseEndpointId' is required");
	if (!getEndpoint(baseEndpointId)) {
		throw error(400, `Unknown endpoint "${baseEndpointId}" — not in config.toml`);
	}

	const baseModelId = body.baseModelId?.trim();
	if (!baseModelId) throw error(400, "'baseModelId' is required");

	const description = body.description?.trim() || null;
	const systemPrompt = body.systemPrompt?.trim() || null;
	const parameters = validateParameters(body.parameters);
	const defaultDisabledFeatures = validateDefaultDisabledFeatures(body.defaultDisabledFeatures);

	return {
		name,
		description,
		baseEndpointId,
		baseModelId,
		systemPrompt,
		parameters,
		defaultDisabledFeatures
	};
}

/** Same shape rules as the per-conversation field — undefined / null → []
 *  (no opt-outs), an array of known categories → de-duped, anything else
 *  → 400. Built-in typos 400 loudly (so a misspelled `web` doesn't
 *  silently become "feature on"). MCP categories (`mcp:<id>`) pass
 *  through even when the named server isn't currently registered: a
 *  config.toml edit that temporarily removes an MCP server shouldn't
 *  invalidate every custom model that mentioned it. Runtime tool
 *  filtering treats absent categories as no-ops, so the data stays
 *  preserved for the user without leaking into the upstream request. */
export function validateDefaultDisabledFeatures(raw: unknown): FeatureCategory[] {
	let normalized: FeatureCategory[];
	try {
		normalized = validateDisabledFeatures(raw);
	} catch (e) {
		if (e instanceof FeatureCategoryValidationError) {
			throw error(400, `defaultDisabledFeatures: ${e.message}`);
		}
		throw e;
	}
	const known = getRegisteredCategoryIds();
	for (const entry of normalized) {
		if (known.has(entry)) continue;
		if (entry.startsWith('mcp:')) continue; // opaque MCP preservation
		throw error(400, `defaultDisabledFeatures: unknown category "${entry}"`);
	}
	return normalized;
}

/**
 * Sanity-check parameter values that we'll forward upstream so a malformed
 * request can't poison stored state. We accept the chat-triplet only in
 * v1; unknown keys are stripped rather than 400'd, so the schema can grow
 * without breaking older client builds.
 */
export function validateParameters(
	raw: CustomModelParameters | undefined | null
): CustomModelParameters | null {
	if (!raw || typeof raw !== 'object') return null;
	const out: CustomModelParameters = {};
	if (raw.temperature !== undefined) {
		if (
			typeof raw.temperature !== 'number' ||
			raw.temperature < 0 ||
			raw.temperature > 2
		) {
			throw error(400, "'temperature' must be a number between 0 and 2");
		}
		out.temperature = raw.temperature;
	}
	if (raw.top_p !== undefined) {
		if (typeof raw.top_p !== 'number' || raw.top_p < 0 || raw.top_p > 1) {
			throw error(400, "'top_p' must be a number between 0 and 1");
		}
		out.top_p = raw.top_p;
	}
	if (raw.max_tokens !== undefined) {
		if (
			typeof raw.max_tokens !== 'number' ||
			!Number.isInteger(raw.max_tokens) ||
			raw.max_tokens < 1
		) {
			throw error(400, "'max_tokens' must be a positive integer");
		}
		out.max_tokens = raw.max_tokens;
	}
	return Object.keys(out).length > 0 ? out : null;
}
