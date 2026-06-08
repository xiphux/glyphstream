/**
 * Per-request skills context, shared by the two handlers that build an
 * upstream chat request — the message send (`/messages`) and the tool-approval
 * resume (`/tool-approval`). Both must inject the same Tier-1 catalog into the
 * system prompt AND advertise the same per-user activation tools, so a turn
 * that activated a skill then paused on an MCP approval keeps both on resume.
 * Centralizing the logic here is the anti-drift measure flagged in the plan.
 *
 * Skills ride their OWN `skills` feature-category gate (not personalization):
 * the catalog injects even for snapshotted custom-model conversations, because
 * a skill is a capability surface, not personal context.
 */
import type { FeatureCategory } from '$lib/types/api';
import { composeSkillsCatalog, listEnabledSkillsForUser } from '../db/queries/skills';
import { skillToolDefinitions } from '../tools/activate-skill';
import type { OpenAIToolDefinition } from '../tools/types';

export interface SkillsRequestContext {
	/** The <available_skills> catalog to append to the system prompt, or null. */
	catalog: string | null;
	/** activate_skill / read_skill_file definitions to append to the tool list. */
	toolDefs: OpenAIToolDefinition[];
}

const EMPTY: SkillsRequestContext = { catalog: null, toolDefs: [] };

/**
 * Resolve the catalog + activation tools for a request. One DB query feeds
 * both the catalog text and the tool enum. Returns the empty context (no
 * catalog, no tools) when the conversation has the `skills` category disabled
 * or the user has no enabled skills — the omit-when-empty contract the spec
 * requires.
 */
export function buildSkillsRequestContext(
	userId: string,
	disabledFeatures: readonly FeatureCategory[],
): SkillsRequestContext {
	if (disabledFeatures.includes('skills')) return EMPTY;
	const enabled = listEnabledSkillsForUser(userId);
	if (enabled.length === 0) return EMPTY;
	return {
		catalog: composeSkillsCatalog(enabled),
		toolDefs: skillToolDefinitions(
			enabled.map((s) => s.name),
			disabledFeatures,
		),
	};
}

/** Join a base system prompt with the skills catalog, dropping nulls. Returns
 *  null only when both are absent. */
export function appendSkillsCatalog(base: string | null, catalog: string | null): string | null {
	return [base, catalog].filter(Boolean).join('\n\n') || null;
}
