/**
 * Per-request persona/system-prompt composition, shared by the two handlers
 * that build an upstream chat request — the message send (`/messages`) and the
 * tool-approval resume (`/tool-approval`). Both must compose the persona prompt
 * (name + about + custom instructions + saved memories) identically, including
 * the inline-vs-recall decision for the memory index, so a turn that paused on
 * an approval resumes with the same context. Centralizing it here is the
 * anti-drift measure (mirrors `skills-context.ts`).
 *
 * The caller passes the already-loaded `prefs` (both handlers also use it for
 * `trustedMcpTools`, so this avoids a second query) and decides the
 * `meta.systemPrompt === null` gate; a snapshotted custom-model conversation
 * keeps its own prompt and never calls this.
 */
import type { FeatureCategory, UserPreferences } from '$lib/types/api';
import { composePersonaSystemPrompt } from '../db/queries/user-preferences';
import {
	listMemoriesForUser,
	listMemoryIndexForUser,
	memoryStats,
	MEMORY_INLINE_BUDGET_CHARS,
} from '../db/queries/memories';

/**
 * Compose the persona system prompt for a user, or null when there's nothing to
 * inject (personalization disabled, or no prefs). Above the inline budget the
 * saved-memory bodies are swapped for the compact `[id] topic` index so a large
 * store doesn't flood the context window; the model reads bodies back via
 * `recall_memory`. Independent of embeddings — recall-by-id needs none.
 *
 * Runs every turn, so it avoids loading memory bodies it won't use: it first
 * probes the store size with a cheap COUNT/SUM. Over budget → index mode, which
 * loads only id/topic/snippet (no bodies). Otherwise → inline mode, which loads
 * the full bodies.
 */
export function composePersonaPrompt(
	prefs: UserPreferences | null,
	userId: string,
	disabledFeatures: readonly FeatureCategory[],
): string | null {
	if (!prefs || disabledFeatures.includes('personalization')) return null;
	const stats = memoryStats(userId);
	if (stats.totalChars > MEMORY_INLINE_BUDGET_CHARS) {
		return composePersonaSystemPrompt(prefs, [], {
			recallMode: true,
			index: listMemoryIndexForUser(userId),
		});
	}
	return composePersonaSystemPrompt(prefs, listMemoriesForUser(userId));
}
